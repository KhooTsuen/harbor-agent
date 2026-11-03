/*
 * 真机端到端：**任务真的在干活时**注入网页内容，那一轮不能被打断。
 *
 * 为什么要有它（2026-11-04 用户报的）：「有消息注入时候还是会打断流式对话，
 * 但是后台依旧进行着任务」。tsc / 单测 / 自检全绿也照样错 —— 它们都不同时跑
 * 「真工具执行 + 真注入 + 真重读盘」这三件事。
 *
 * ★ 时序是全部关键（用户纠正原话：「应该是发出问题，然后任务正在进行，然后再注入」）。
 *   上一版用 `slow` 模式（只发文本 token、零次工具调用），并在第一个字上屏 1.6 秒后
 *   就注入 —— 那既不是「任务在进行」，也不是用户遇到的场景。现在的每一步都是**等出来的**：
 *     ① 发问题 ② 等「停止生成」出现（真在跑） ③ 等盘上跑完 ≥2 轮工具（真在干活）
 *     ④ **这时**才注入 ⑤ 再等 ≥2 轮工具 + 界面仍在跑 ⑥ 收尾查会话文件是否完整
 *
 * 判据为什么读盘：跑的时候界面**只给「实时任务」四个字**（processSummary.ts 四档口径），
 * 工具明细要等收尾才渲染 —— 按 `data-run-status` 判「在干活」永远读不到（上一版就假红在这里）。
 *
 * 链路全真，只有模型是假的：真 Electron（源码树）→ 真界面 → CDP 点发送 → 真 chat handler
 * → 真 loop.cjs → 假上游 `busy`（每 1.2 秒一条 `run_shell`）→ 内核**真执行** `dir` →
 * 期间经真管道发 `ext:page` → 主进程真落盘 + 真推 → 渲染层真重读盘。数据隔离：
 * HARBOR_UNIT_TEST=1 → data/unit-test-data。
 *
 * 零件（改隔离数据 / 读盘数轮次 / 发管道）在 `tools/e2e-ingest-kit.mjs`；这里只留流程与判据。
 *
 *   node tools/e2e-ingest-keeps-stream.mjs   → shots/electron/ingest-keeps-stream.png
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, sleep, findPageTarget, evaluate } from './shot/cdp.mjs'
import { NEW_CHAT, SEND, RUNNING } from './shot/ui-selectors.mjs'
import {
  maskData,
  busyRoundOnDisk,
  sendExtPage,
  fillExpr,
  LAST_MSG,
  LIVE,
  NOTE_SEEN,
  BODY_TEXT,
} from './e2e-ingest-kit.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ISO = resolve(ROOT, 'data', 'unit-test-data')
const SESSIONS = resolve(ISO, 'sessions')
const PORT = 9383
const FAKE_PORT = 9983
/* 每轮工具之间的节奏（脚本要在这段时间里注入）· 总轮数 → 约 17 秒的进行中窗口 */
const PACE_MS = 1200
const BUSY_ROUNDS = 14
const SHOT = resolve(ROOT, 'shots', 'electron', 'ingest-keeps-stream.png')

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? '✓' : '✗'} ${name} —— ${detail}`)
}

/* ── 1. 隔离数据指向假上游（跑完还原）── */
const restoreData = maskData({
  conf: resolve(ISO, 'config.json'),
  cred: resolve(ISO, 'credentials.json'),
  baseUrl: `http://127.0.0.1:${FAKE_PORT}/v1-busy`,
})
/* 起点：隔离区可能留着上一次跑过的会话文件 —— 按开跑时刻过滤，只认「这次新写的」 */
const STARTED_AT = Date.now()
const roundNow = () => busyRoundOnDisk(SESSIONS, STARTED_AT)

/* ── 2. 假上游（busy：每轮一条真工具调用）── */
const upstream = spawn(process.execPath, [resolve(ROOT, 'tools', 'fake-upstream.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    FAKE_PORT: String(FAKE_PORT),
    FAKE_BUSY_PACE_MS: String(PACE_MS),
    FAKE_BUSY_ROUNDS: String(BUSY_ROUNDS),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
upstream.stdout.on('data', (b) => process.stdout.write(`  [上游] ${b}`))
upstream.stderr.on('data', (b) => process.stderr.write(`  [上游err] ${b}`))

/* ── 3. 真 Electron（源码树，隔离数据根）── */
const app = spawn(BIN, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HARBOR_UNIT_TEST: '1' },
})
let appLog = ''
app.stdout.on('data', (b) => (appLog += b.toString()))
app.stderr.on('data', (b) => (appLog += b.toString()))
const killApp = () => spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })

/** 反复读某个表达式直到条件成立（返回最后一次读到的值；超时返回 null） */
async function waitFor(ev, expr, ok, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await ev(expr, label)
    if (ok(last)) return last
    await sleep(300)
  }
  return null
}

let cdp
try {
  await sleep(1500)
  const target = await findPageTarget(PORT, { timeoutMs: 45000 })
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const ev = (expr, label) => evaluate(cdp, expr, { label })

  const ready = await waitFor(ev, `!!document.querySelector('textarea')`, (v) => v === true, 30000, '等输入框')
  rec('界面就绪（有输入框）', ready === true, ready === true ? 'textarea 出现' : '30 秒没等到')
  if (ready !== true) throw new Error('界面没起来')

  await ev(NEW_CHAT, '新建对话')
  await sleep(1200)
  await ev(fillExpr('把这些目录逐个核对一遍'), '填输入框')
  await sleep(300)
  rec('发送按钮可点', (await ev(SEND, '点发送')) === true, '已点发送')

  /* ② 这一轮真的在跑：「停止生成」按钮出现 */
  const running = await waitFor(ev, RUNNING, (v) => v === true, 40000, '等开始跑')
  rec('★ 这一轮真的在跑（停止生成按钮出现）', running === true, running === true ? '出现停止按钮' : '40 秒没开始')
  if (running !== true) throw new Error('任务没跑起来，后面的判据无意义')

  /* ③ 任务真的在干活：界面在跑 + 盘上已经跑完 ≥2 轮工具 */
  let busyRound = 0
  const t1 = Date.now()
  while (Date.now() < t1 + 60000) {
    if ((await ev(LIVE, '等任务干活')) === '实时任务' && roundNow() >= 2) {
      busyRound = roundNow()
      break
    }
    await sleep(250)
  }
  rec(
    '★★ 任务正在干活（界面在跑 + 盘上已跑完 ≥2 轮工具）',
    busyRound >= 2,
    busyRound >= 2 ? `第 ${busyRound} 轮工具已执行完并回写` : '60 秒没等到',
  )
  if (busyRound < 2) throw new Error('没等到「任务在干活」的时刻，注入就复现不了用户场景')

  const before = await ev(LAST_MSG, '注入前读最后一条')

  /* ④ ★ 这时注入：走真管道 + 真 token */
  const reply = await sendExtPage({
    iso: ISO,
    payload: {
      url: 'https://example.com/e2e-busy',
      title: '任务进行中注入的页面',
      text: '这是端到端测试注入的网页正文，用来验证它不会把正在干活的那一轮顶掉。',
    },
  })
  const ok = reply && reply.ok !== false && !reply.error
  const targetSession = String(reply?.payload?.sessionId ?? reply?.sessionId ?? '')
  rec('注入请求被主进程接收', ok, ok ? `sessionId=${targetSession}` : String(reply?.error))

  /* ⑤ 给它几百毫秒把重读盘做完（旧 bug 就在这一步把占位顶掉） */
  await sleep(700)
  const afterHydrate = await ev(LAST_MSG, '注入后立刻读')
  const sameId = afterHydrate && before && afterHydrate.id === before.id
  rec(
    '★★ 注入后最后那条还是同一条（id 没被换掉）',
    sameId,
    sameId ? `id=${before.id}` : `注入前 ${before?.id} → 注入后 ${afterHydrate?.id}（被顶掉了）`,
  )

  /* ⑥ 再等 ≥2 轮工具：任务必须继续推进，界面也必须**还在跑**
        （掉出 `.process-live` 就是「显示上被打断了」，正是用户报的症状） */
  let laterRound = 0
  let stillLive = ''
  const t2 = Date.now()
  while (Date.now() < t2 + 20000) {
    const live = await ev(LIVE, '等任务继续')
    if (roundNow() >= busyRound + 2) {
      laterRound = roundNow()
      stillLive = live
      break
    }
    await sleep(300)
  }
  rec(
    '★★ 注入之后任务**继续推进**（盘上又多了 ≥2 轮工具）',
    laterRound >= busyRound + 2,
    laterRound >= busyRound + 2 ? `第 ${busyRound} 轮 → 第 ${laterRound} 轮` : '20 秒内没再推进',
  )
  rec(
    '★★ 注入之后界面**还在跑**（`.process-live` 没消失）',
    stillLive === '实时任务',
    stillLive === '实时任务' ? '入口还是「实时任务」' : `入口变成「${stillLive || '(没有了)'}」`,
  )
  const visible = await ev(NOTE_SEEN, '注入的卡片在不在')
  rec('★ 注入的内容看得见（折叠卡）', visible === true, visible ? '「已读取网页」出现' : '界面上找不到')

  /* 等这一轮跑完（busy 共 14 轮） */
  const finished = await waitFor(ev, BODY_TEXT, (v) => typeof v === 'string' && v.includes('任务结束'), 90000, '等收尾')
  rec('这一轮真的跑完（14 轮都到了）', finished !== null, finished ? '正文里有「任务结束」' : '90 秒没等到')

  /* 收尾落盘：**只看这一条会话**的文件（读整个目录会把上一次跑的也读进来，
     于是修复前也能"通过" —— 这条判据第一版就是这么假绿的） */
  await sleep(1500)
  let diskText = ''
  let diskFiles = ''
  try {
    const files = readdirSync(SESSIONS).filter(
      (f) => f.endsWith('.jsonl') && (!targetSession || f.startsWith(targetSession)),
    )
    diskFiles = files.join(', ') || '（没有匹配的会话文件）'
    for (const f of files) diskText += readFileSync(resolve(SESSIONS, f), 'utf8')
  } catch (error) {
    diskText = `（读会话目录失败：${error.message}）`
  }
  const finalSaved = diskText.includes('任务结束')
  rec(
    '★★★ 收尾完整落盘（这条会话的文件里有「任务结束」，不是只剩半截快照）',
    finalSaved,
    `${diskFiles} ${finalSaved ? '里找到完整回复' : '里找不到最后一片 —— 整轮没写盘'}`,
  )
  const noteSaved = diskText.includes('端到端测试注入的网页正文')
  rec('★ 注入的网页正文也落进了会话文件', noteSaved, noteSaved ? '已落盘' : '没找到')

  try {
    mkdirSync(resolve(ROOT, 'shots', 'electron'), { recursive: true })
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
    console.log(`  截图 → ${SHOT}`)
  } catch (error) {
    console.log(`  （截图失败：${error.message}）`)
  }
} catch (error) {
  rec('脚本跑完', false, String(error?.message ?? error))
  if (appLog) console.log(`\n[应用日志尾部]\n${appLog.slice(-2000)}`)
} finally {
  killApp()
  upstream.kill()
  await sleep(800)
  restoreData()
}

const failed = results.filter((r) => !r.pass).length
console.log(failed === 0 ? `\n✅ 全过（${results.length}/${results.length}）` : `\n❌ ${failed} 项没过（共 ${results.length}）`)
process.exit(failed === 0 ? 0 : 1)
