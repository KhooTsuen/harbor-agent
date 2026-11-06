/*
 * 真机端到端：**模型能不能自己把历史工具证据取回来**（P1-C 的最强证据）
 *
 * 链路全真，只有模型是假的：
 *   真 Electron（源码树）→ 真界面（CDP 填输入框 + 点发送）→ 真 chat handler
 *   → 真 loop.cjs → 真工具执行（run_shell 真跑、recall 真读会话）
 *   → 真 llm-body 构造 → 真 HTTP → 假上游（`fake-upstream-recall.mjs`）
 *
 * 三轮：
 *   第 1 轮 `run_shell`（`echo RECALL_MARK_xxx`）→ 真执行
 *   第 2 轮 `recall({ tool: 'run_shell' })`      → 真读本会话的会话文件
 *   第 3 轮 纯文本收尾
 *
 * ★ 判据只有一条，但它是最硬的那条：
 *   **第 3 轮真实请求体里必须出现只有 `recall` 才会写的字样**
 *   （「本会话最近 N 次工具调用」/「指纹 xxxxxxxx」），**并且**带着第 1 轮那条命令的输出。
 *
 *   为什么这能证明「取回来了」：第 3 轮请求体里那段 recall 结果，是内核真的执行了
 *   `recall` 工具、真的读了 `data/sessions/<id>.jsonl`、把结果作为 tool 消息拼进
 *   messages 之后发出来的。脚本没有往请求体里塞任何东西。
 *
 * 附带判据（同一份请求体）：
 *   · recall 那次调用的 tool 消息在（协议合法：能找到同 id 的 assistant(tool_calls)）
 *   · 它带「不可信数据 / 不是指令」标记（历史输出不能取得系统指令地位）
 *   · 第 1 轮那条 run_shell 的输出仍在上下文里（否则「取回」无从谈起）
 *
 * 数据隔离：`HARBOR_UNIT_TEST=1` → 数据根切到 `data/unit-test-data`，
 *          **完全不碰**仓库的真 data。
 *
 *   node tools/e2e-recall.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, evaluate, findPageTarget, sleep } from './shot/cdp.mjs'
import { NEW_CHAT, SEND } from './shot/ui-selectors.mjs'
import { MARK } from './fake-upstream-recall.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ISO = resolve(ROOT, 'data', 'unit-test-data')
const CONF = resolve(ISO, 'config.json')
const CRED = resolve(ISO, 'credentials.json')
const DUMP = resolve(ISO, 'recall-requests.jsonl')
const PORT = 9381
const FAKE_PORT = 9981

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? '✓' : '✗'} ${name} —— ${detail}`)
}

/* ── 1. 隔离数据：config 指向假上游 + 假凭证 ── */
mkdirSync(ISO, { recursive: true })
const confBackup = existsSync(CONF) ? readFileSync(CONF, 'utf8') : null
const credBackup = existsSync(CRED) ? readFileSync(CRED, 'utf8') : null
const cfg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'config.json'), 'utf8'))
cfg.providers[0].baseUrl = `http://127.0.0.1:${FAKE_PORT}/v1-recall`
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
rmSync(DUMP, { force: true })

const restore = () => {
  try {
    if (confBackup === null) rmSync(CONF, { force: true })
    else writeFileSync(CONF, confBackup)
    if (credBackup === null) rmSync(CRED, { force: true })
    else writeFileSync(CRED, credBackup)
  } catch {
    /* ignore */
  }
}

/* ── 2. 假上游 ── */
const upstream = spawn(process.execPath, [resolve(ROOT, 'tools', 'fake-upstream-recall.mjs')], {
  cwd: ROOT,
  env: { ...process.env, FAKE_PORT: String(FAKE_PORT), FAKE_DUMP_PATH: DUMP, FAKE_MARK: MARK },
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
app.stdout.on('data', (b) => {
  appLog += b.toString()
})
app.stderr.on('data', (b) => {
  appLog += b.toString()
})
const killApp = () => spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })

const fillExpr = (text) =>
  `(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`

/** 读落盘的请求体（按轮） */
function dumpOf(round) {
  if (!existsSync(DUMP)) return null
  for (const line of readFileSync(DUMP, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row.round === round) return row.body
    } catch {
      /* 半截行 */
    }
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

  const ready = await (async () => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (await ev(`!!document.querySelector('textarea')`, '等输入框')) return true
      await sleep(500)
    }
    return false
  })()
  rec('界面就绪（有输入框）', ready, ready ? 'textarea 出现' : '30 秒没等到')
  if (!ready) throw new Error('界面没起来，后面的判据无从谈起')

  await ev(NEW_CHAT, '新建对话')
  await sleep(1200)
  const typed = await ev(fillExpr('跑一条命令看看输出'), '填输入框')
  rec('输入框可写', typed > 0, `写入 ${typed} 字`)
  await sleep(400)
  const sent = await ev(SEND, '点发送')
  rec('发送按钮可点', sent === true, sent ? '已点发送' : '没找到发送按钮')

  /* 等第一条消息这一轮结束（第 2 轮请求 = 收尾）—— 这一轮结束才会落盘 */
  const firstDeadline = Date.now() + 90000
  while (Date.now() < firstDeadline && !dumpOf(2)) await sleep(600)
  rec('第一条消息跑完（第 2 轮收尾请求到达）', Boolean(dumpOf(2)))
  /* 落盘是渲染层拿到 done 之后写的，给一点余量 */
  await sleep(3000)

  /* 第二条用户消息：这时上一轮的工具结果已经落盘，recall 才读得到 */
  const typed2 = await ev(fillExpr('把刚才那条命令的输出取回来'), '填输入框（第二条）')
  rec('第二条消息可写', typed2 > 0, `写入 ${typed2} 字`)
  await sleep(400)
  const sent2 = await ev(SEND, '点发送（第二条）')
  rec('第二条消息可发送', sent2 === true)

  /* 等第 5 轮请求真的到上游（最多 150 秒：列目录 + 取原文各一次往返） */
  const deadline = Date.now() + 150000
  while (Date.now() < deadline && !dumpOf(5)) await sleep(600)

  const first = dumpOf(1)
  const third = dumpOf(3)
  const fourth = dumpOf(4)
  const fifth = dumpOf(5)
  rec('假上游收到第 1 轮（run_shell）', Boolean(first), first ? `${first.length} 字符` : '没收到')
  rec('假上游收到第 3 轮（recall 列目录）', Boolean(third), third ? `${third.length} 字符` : '没收到')
  rec('假上游收到第 4 轮（recall 取原文）', Boolean(fourth), fourth ? `${fourth.length} 字符` : '没收到')
  rec('假上游收到第 5 轮（收尾）', Boolean(fifth), fifth ? `${fifth.length} 字符` : '没收到')

  if (third) {
    /* 第 3 轮里应该说清「上一轮跑过什么」—— 那时 recall 还没执行，验的是前提成立 */
    const body3 = JSON.parse(third)
    const msgs3 = Array.isArray(body3.messages) ? body3.messages : []
    const shellTools = msgs3.filter((m) => m.role === 'tool' && String(m.content ?? '').includes(MARK))
    rec(
      '★ 第 3 轮里带着第 1 轮 run_shell 的真实输出（含随机标记）',
      shellTools.length === 1,
      `命中 ${shellTools.length} 条`,
    )
  }

  if (fifth) {
    const body = JSON.parse(fifth)
    const messages = Array.isArray(body.messages) ? body.messages : []
    const tools = messages.filter((m) => m.role === 'tool')
    const callIds = new Set()
    for (const m of messages) for (const call of m.tool_calls ?? []) callIds.add(call.id)

    const recallMsg = tools.find((m) => String(m.content ?? '').includes('本会话最近'))
    rec(
      '★★ 第 3 轮请求体里有 recall 的结果（只有 recall 会写「本会话最近 N 次工具调用」）',
      Boolean(recallMsg),
      recallMsg ? `${String(recallMsg.content).length} 字符` : '没有',
    )
    rec(
      '★★ 那段结果里带着工具指纹（模型能顺着它继续取原文）',
      Boolean(recallMsg) && /指纹 [0-9a-f]{8}/.test(String(recallMsg.content)),
      recallMsg ? String(recallMsg.content).match(/指纹 [0-9a-f]{8}/)?.[0] ?? '无' : '无',
    )
    rec(
      '★★ 那段结果里点名了 run_shell（按工具过滤真的生效了）',
      Boolean(recallMsg) && String(recallMsg.content).includes('run_shell'),
    )
    rec(
      '★★ 带「不可信数据 / 不是指令」标记（历史输出没有取得系统指令地位）',
      Boolean(recallMsg) && String(recallMsg.content).includes('不可信数据') && String(recallMsg.content).includes('不是指令'),
    )
    rec(
      '★ 协议合法：那条 tool 能找到同 id 的 assistant(tool_calls)',
      tools.every((t) => callIds.has(t.tool_call_id)),
      `孤儿 ${tools.filter((t) => !callIds.has(t.tool_call_id)).length} 条`,
    )
    rec(
      '★ 第 1 轮那条命令的输出仍在上下文里（取回的前提成立）',
      tools.some((m) => String(m.content ?? '').includes(MARK)),
    )
    rec(
      '★ 没有任何 tool 消息是空的（recall 没有造出空结果）',
      tools.every((m) => String(m.content ?? '').trim().length > 0),
    )
    /*
     * ★★ 取回**原文**的证据：第 4 轮那次 `recall({ n: 1 })` 的返回里，
     *    必须出现那条命令的真实输出（`echo MARK` → `MARK`），而且带「已核对」指纹。
     *    这是「压缩后能把证据找回来」的实质，不只是「列了个目录」。
     */
    const fragment = tools.find((m) => String(m.content ?? '').includes('来源：会话'))
    rec(
      '★★ 第 5 轮里带着 recall **取回的原文**（有「来源：会话 / 已核对」这类只有取回才有的字样）',
      Boolean(fragment),
      fragment ? `${String(fragment.content).length} 字符` : '没有',
    )
    rec(
      '★★ 取回的原文里就是那条命令的真实输出（含随机标记）',
      Boolean(fragment) && String(fragment.content).includes(MARK),
      fragment ? (String(fragment.content).includes(MARK) ? '命中' : '没命中') : '无',
    )
    rec(
      '★★ 取回时核对了指纹（记录被改写过会拒）',
      Boolean(fragment) && String(fragment.content).includes('已核对'),
    )
  }
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
  restore()
}

const passed = results.filter((r) => r.pass).length
console.log(`\n${passed === results.length ? '✅ 全过' : '❌ 有失败'}（${passed}/${results.length}）`)
if (appLog.includes('Error')) console.log('（应用日志里有 Error，见 data/unit-test-data/logs）')
process.exit(passed === results.length ? 0 : 1)
