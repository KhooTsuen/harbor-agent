/*
 * 真机端到端：**自我纠错闭环在真实执行里成立吗**（四个反例修复后的验收）
 *
 * 为什么必须真机：`193` / `195` / `196` 都是在纯 Node 里直接调内核函数 ——
 * 它们能证明「判据写得对」，证明不了「真跑一遍工具调用时这条链还在」。
 * 2026-11-02 就出过这种事故：接线断了，自检照样全绿。
 *
 * 链路全真，只有模型是假的：
 *   真 Electron（源码树）→ 真界面 → CDP 点发送 → 真 chat handler → 真 loop.cjs
 *   → 真 tool-runner → 真 run_shell（`type harbor-e2e-flag.txt`）→ 真退出码
 *   → 真 experience-loop → 真 data/experiences.json
 *
 * 剧本（文件状态由本例控制，所以「失败/成功」是真的）：
 *   ① 文件不存在 → 命令退出码 1 → 落一条 **candidate**，且提示里没有它
 *   ② 造出文件 → 同一条命令成功 → 验证器真去看退出码 → 认下修法
 *   ③ 再成功 → 计数；再成功 → **verified**
 *   ④ 删掉文件 → 同一条命令再失败 → **suspended**，此后不再注入
 *
 * 判据读的是**磁盘上的 experiences.json** 与**真实 DOM**，不是自己拼的对象。
 *
 *   node tools/e2e-experience-loop.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, sleep, findPageTarget, evaluate } from './shot/cdp.mjs'
import { NEW_CHAT, SEND } from './shot/ui-selectors.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ISO = resolve(ROOT, 'data', 'unit-test-data')
const CONF = resolve(ISO, 'config.json')
const CRED = resolve(ISO, 'credentials.json')
const EXP = resolve(ISO, 'experiences.json')
const WORK = resolve(ISO, 'workspace')
const FLAG = resolve(WORK, 'harbor-e2e-flag.txt')
const PORT = 9383
const FAKE_PORT = 9983
const SHOT = resolve(ROOT, 'shots', 'electron', 'experience-loop.png')

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? '✓' : '✗'} ${name} —— ${detail}`)
}

mkdirSync(ISO, { recursive: true })
mkdirSync(WORK, { recursive: true })
const confBackup = existsSync(CONF) ? readFileSync(CONF, 'utf8') : null
const credBackup = existsSync(CRED) ? readFileSync(CRED, 'utf8') : null
const cfg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'config.json'), 'utf8'))
cfg.providers[0].baseUrl = `http://127.0.0.1:${FAKE_PORT}/v1-experience`
/*
 * 会话里可能记着别的模型名（`deepseek-flash` 之类，来自上一次真机验收的 UI 状态）。
 * 它不在供应商的模型列表里时，渲染层会**直接拒发**（「所选模型没有可用连接」），
 * 于是脚本点发送什么也没发生 —— 这不是本次要验的东西，所以把候选模型都挂上。
 */
cfg.providers[0].models = [...new Set([...(cfg.providers[0].models ?? []), 'deepseek-chat', 'deepseek-flash'])]
cfg.security = { ...(cfg.security ?? {}), network: { ...(cfg.security?.network ?? {}), mode: 'allow' } }
/* 权限 full：这条 e2e 验的是经验闭环，不是「确认卡拦没拦住」——
   ask 档会让 run_shell 先弹卡，脚本没点它 → 命令根本没跑（2026-11-02 踩过） */
cfg.tools = { ...(cfg.tools ?? {}), permission: 'full' }
writeFileSync(CONF, JSON.stringify(cfg, null, 2))
writeFileSync(
  CRED,
  JSON.stringify(
    {
      version: 1,
      backend: 'plain',
      entries: { [cfg.providers[0].credentialRef]: { value: 'sk-e2e', updatedAt: Date.now() } },
    },
    null,
    2,
  ),
)

/* 每条验收都从空库、没有标志文件开始 */
rmSync(EXP, { force: true })
rmSync(FLAG, { force: true })

const restoreData = () => {
  try {
    if (confBackup === null) rmSync(CONF, { force: true })
    else writeFileSync(CONF, confBackup)
    if (credBackup === null) rmSync(CRED, { force: true })
    else writeFileSync(CRED, credBackup)
  } catch {
    /* ignore */
  }
}

/** 读盘上的经验库（真文件，不是内存） */
const readExp = () => {
  try {
    const parsed = JSON.parse(readFileSync(EXP, 'utf8'))
    return Array.isArray(parsed.items) ? parsed.items : []
  } catch {
    return []
  }
}
/** 库里「那条命令」的经验（`target` 是命令首段，见 experience-text.targetOf） */
const shellItem = () => readExp().find((item) => item.tool === 'run_shell') ?? null

const upstream = spawn(process.execPath, [resolve(ROOT, 'tools', 'fake-upstream.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    FAKE_PORT: String(FAKE_PORT),
    FAKE_EXPERIENCE_ROUNDS: '40',
    FAKE_EXPERIENCE_PACE_MS: '1200',
    /* 绝对路径：`run_shell` 会在**会话的工作目录**里跑（实测会继承上一次的目录），
       相对路径会被解析到那边去 → 命令永远找不到标志文件、永远失败（2026-11-02 真机逮到） */
    FAKE_EXPERIENCE_FLAG: FLAG,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
upstream.stdout.on('data', (b) => process.stdout.write(`  [上游] ${b}`))
upstream.stderr.on('data', (b) => process.stderr.write(`  [上游err] ${b}`))

const app = spawn(BIN, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HARBOR_UNIT_TEST: '1' },
})
const killApp = () => spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })

const fillExpr = (text) =>
  `(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`
const READ_RUNS = `(function(){const rows=[...document.querySelectorAll('[data-run-status]')];return rows.map(r=>({status:r.getAttribute('data-run-status'),text:(r.textContent||'').trim().slice(0,160)}))})()`
const READ_BODY = `(function(){const m=document.querySelector('main')||document.body;return (m.textContent||'').replace(/\\s+/g,' ').slice(-4000)})()`

/** 等某个条件成立（每 700ms 轮询），返回是否等到了 */
async function waitFor(label, fn, ms = 90000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(700)
  }
  console.log(`  （等超时：${label}）`)
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

  const ready = await waitFor('界面就绪', () => ev(`!!document.querySelector('textarea')`, '等输入框'), 30000)
  rec('界面就绪（有输入框）', Boolean(ready), ready ? 'textarea 出现' : '30 秒没等到')
  if (!ready) throw new Error('界面没起来')

  await ev(NEW_CHAT, '新建对话')
  await sleep(1200)
  await ev(fillExpr('帮我确认一下那个标志文件在不在'), '填输入框')
  await sleep(300)
  rec('发送按钮可点', (await ev(SEND, '点发送')) === true, '已点发送')

  /* ── ① 第一次真失败 → candidate，且提示里没有它 ── */
  const born = await waitFor('第一条候选落盘', () => {
    const item = shellItem()
    return item && item.status === 'candidate' ? item : null
  })
  rec(
    '★★ 真失败落成 candidate（磁盘上的 experiences.json 里读出来的）',
    Boolean(born) && born.status === 'candidate',
    born ? `status=${born.status} reasonCode=${born.reasonCode} reproductions=${born.reproductions}` : '没有落盘',
  )
  rec(
    '★ 候选记着目标（命令首段）',
    Boolean(born) && String(born.target ?? '').includes('type'),
    String(born?.target ?? ''),
  )
  const body1 = await ev(READ_BODY, '读正文')
  rec(
    '★★ 这一轮正文里没有「以前遇到过同类情况」（失败没当场变成规则）',
    typeof body1 === 'string' && !body1.includes('[以前遇到过同类情况]'),
    String(body1 ?? '').slice(-200),
  )
  rec(
    '★ 这一次也一次都没注入过',
    (shellItem()?.injectedCount ?? 0) === 0,
    String(shellItem()?.injectedCount),
  )

  /* ── ② 造出文件 → 同一条命令真成功 → 验证器真去看退出码 ── */
  writeFileSync(FLAG, 'ok\n', 'utf8')
  const adopted = await waitFor('认下修法', () => {
    const item = shellItem()
    return item && Number(item.verifications?.length ?? 0) >= 1 ? item : null
  })
  rec(
    '★★ 文件出现后同一条命令成功 → 记下一次独立验证',
    Boolean(adopted),
    adopted ? `verifications=${adopted.verifications.length}` : '没有验证记录',
  )
  rec(
    '★ 验证记的是验证器 id（shell_exit_zero@…，不是模型自述）',
    (adopted?.verifications ?? []).some((entry) => String(entry.verifier).startsWith('shell_exit_zero@')),
    JSON.stringify((adopted?.verifications ?? []).map((entry) => entry.verifier)),
  )
  rec(
    '★ 认下了修法签名（同一条命令）',
    String(shellItem()?.recipe?.key ?? '').startsWith('run_shell|'),
    String(shellItem()?.recipe?.key ?? ''),
  )

  /* ── ③ 继续同修法成功 → verified ── */
  const verified = await waitFor('升为 verified', () => {
    const item = shellItem()
    return item && item.status === 'verified' ? item : null
  }, 120000)
  rec(
    '★★ 同一修法被多次独立核实后升为 verified',
    Boolean(verified),
    verified ? `status=${verified.status} verifications=${verified.verifications.length}` : String(shellItem()?.status),
  )

  /* ── ④ 删掉文件 → 同一条命令再失败 → suspended ── */
  rmSync(FLAG, { force: true })
  const suspended = await waitFor('被反例打停', () => {
    const item = shellItem()
    return item && item.status === 'suspended' ? item : null
  }, 120000)
  rec(
    '★★ 删掉文件后同一条命令再失败 → suspended（停止注入）',
    Boolean(suspended),
    suspended ? `status=${suspended.status} contradictions=${suspended.contradictions.length}` : String(shellItem()?.status),
  )
  rec(
    '★ 反例被记账（谁、哪次、证据）',
    (suspended?.contradictions ?? []).length >= 1,
    JSON.stringify((suspended?.contradictions ?? []).map((entry) => String(entry.evidence).slice(0, 40))),
  )
  const body2 = await ev(READ_BODY, '读正文')
  rec(
    '★★ 暂停之后正文里不再有那句（不再误导模型）',
    typeof body2 === 'string' && !body2.includes('[以前遇到过同类情况]'),
    String(body2 ?? '').slice(-200),
  )

  const rows = await ev(READ_RUNS, '读工具行')
  rec(
    '★ 界面上真出现过「失败」的行（不是全绿）',
    Array.isArray(rows) && rows.some((r) => r.status === 'failed'),
    JSON.stringify((rows ?? []).map((r) => r.status).slice(0, 8)),
  )

  /* 截图：跳过开机动画（用真实鼠标事件，见 tool-failure-visible 的注释） */
  const bootOn = `(function(){return [...document.querySelectorAll('div')].some(n=>(n.textContent||'').includes('CLICK TO SKIP') && n.clientHeight>0)})()`
  if (await ev(bootOn, '启动层在不在')) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: 400, y: 300, button: 'left', clickCount: 1 })
    }
    await sleep(1500)
  }
  await sleep(800)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(resolve(ROOT, 'shots', 'electron'), { recursive: true })
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
  console.log(`  截图 → ${SHOT}`)
} catch (error) {
  console.error('E2E 失败：', error instanceof Error ? error.message : error)
  rec('E2E 跑通', false, String(error?.message ?? error))
} finally {
  try {
    cdp?.ws.close()
  } catch {
    /* ignore */
  }
  killApp()
  spawn('taskkill', ['/pid', String(upstream.pid), '/T', '/F'], { stdio: 'ignore' })
  rmSync(FLAG, { force: true })
  restoreData()
}

const passed = results.filter((r) => r.pass).length
console.log(`\n${passed === results.length ? '✅ 全过' : '❌ 有失败'}（${passed}/${results.length}）`)
process.exit(passed === results.length ? 0 : 1)
