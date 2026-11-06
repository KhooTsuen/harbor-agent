/*
 * 真机端到端：**工具输出到底有没有进模型请求体**（P1-A 的最强证据）
 *
 * 链路全真，只有模型是假的：
 *   真 Electron（源码树）→ 真界面（CDP 填输入框 + 点发送）→ 真 chat handler
 *   → 真 loop.cjs → 真 llm-body 构造 → 真 HTTP → 假上游（`fake-upstream-context.mjs`）
 *
 * 假上游第 1 轮发 **12 个 tool_calls 且正文为空**（正是 `loop.cjs` 写
 * `content: result.content || ''` 时真实会话的形状），第 2 轮发纯文本收尾。
 *
 * ★ 判据只有一条，但它是最硬的那条：
 *   **第 2 轮真实请求体里必须有第 1 轮的 12 条工具结果。**
 *
 *   改前实测（P0）：这种形状下 62 条消息只进 2 条 / 13 字符，工具结果一条都不在。
 *   所以这条判据在改动前是红的 —— 它真的在测那个 bug，不是在测「能跑通」。
 *
 * 附带判据（同一份请求体，不另造数）：
 *   · 协议合法：每个 `tool` 都能在同一条 `assistant(tool_calls)` 里找到同 id；
 *   · 12 个调用 id 全都在（没有被裁成子集）；
 *   · 那条 assistant 的正文仍是空串（不编造它没说过的话）。
 *
 * 数据隔离：`HARBOR_UNIT_TEST=1` → 数据根切到 `data/unit-test-data`，
 *          **完全不碰**仓库的真 data（与 vitest / 其它 e2e 同一套开关）。
 *
 *   node tools/e2e-context-integrity.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, evaluate, findPageTarget, sleep } from './shot/cdp.mjs'
import { NEW_CHAT, SEND } from './shot/ui-selectors.mjs'
import { TOOL_COUNT } from './fake-upstream-context.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ISO = resolve(ROOT, 'data', 'unit-test-data')
const CONF = resolve(ISO, 'config.json')
const CRED = resolve(ISO, 'credentials.json')
const DUMP = resolve(ISO, 'ctx-requests.jsonl')
const PORT = 9378
const FAKE_PORT = 9978

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
cfg.providers[0].baseUrl = `http://127.0.0.1:${FAKE_PORT}/v1-ctx`
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
const upstream = spawn(process.execPath, [resolve(ROOT, 'tools', 'fake-upstream-context.mjs')], {
  cwd: ROOT,
  env: { ...process.env, FAKE_PORT: String(FAKE_PORT), FAKE_DUMP_PATH: DUMP },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let upstreamLog = ''
upstream.stdout.on('data', (b) => {
  upstreamLog += b.toString()
  process.stdout.write(`  [上游] ${b}`)
})
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
  const typed = await ev(fillExpr('把那 12 个探测文件都读一遍'), '填输入框')
  rec('输入框可写', typed > 0, `写入 ${typed} 字`)
  await sleep(400)
  const sent = await ev(SEND, '点发送')
  rec('发送按钮可点', sent === true, sent ? '已点发送' : '没找到发送按钮')

  /* 等第 2 轮请求真的到上游（最多 90 秒） */
  const deadline = Date.now() + 90000
  while (Date.now() < deadline && !dumpOf(2)) await sleep(600)

  const first = dumpOf(1)
  rec('假上游收到第 1 轮请求', Boolean(first), first ? `${first.length} 字符` : '没收到')

  const second = dumpOf(2)
  rec('假上游收到第 2 轮请求', Boolean(second), second ? `${second.length} 字符` : '没收到')

  if (second) {
    const body = JSON.parse(second)
    const messages = Array.isArray(body.messages) ? body.messages : []
    const tools = messages.filter((m) => m.role === 'tool')
    const callIds = new Set()
    for (const m of messages) for (const call of m.tool_calls ?? []) callIds.add(call.id)

    rec(
      `★★ 第 2 轮请求体里带着第 1 轮的 ${TOOL_COUNT} 条工具结果`,
      tools.length === TOOL_COUNT,
      `实际 ${tools.length} 条`,
    )
    rec(
      '★★ 协议合法：每条 tool 都能找到同 id 的 assistant(tool_calls)',
      tools.every((t) => callIds.has(t.tool_call_id)) && tools.length > 0,
      `孤儿 ${tools.filter((t) => !callIds.has(t.tool_call_id)).length} 条`,
    )
    rec(
      `★★ 12 个调用 id 全在（没被裁成子集）`,
      Array.from({ length: TOOL_COUNT }, (_, i) => `ctx_${i}`).every((id) => callIds.has(id)),
      `收到 ${callIds.size} 个 id`,
    )
    const emptyHead = messages.filter((m) => m.role === 'assistant' && (m.tool_calls ?? []).length > 0)
    rec(
      '★ 那条 assistant 的正文仍是空串（不编造它没说过的话）',
      emptyHead.length > 0 && emptyHead.every((m) => !m.content),
      JSON.stringify(emptyHead.map((m) => String(m.content ?? '').length)),
    )
    rec(
      '★ 工具输出正文真的在（不是只留了 id）',
      tools.some((t) => String(t.content ?? '').length > 10),
      `最长一条 ${Math.max(0, ...tools.map((t) => String(t.content ?? '').length))} 字符`,
    )
    /* 上一轮的 user 原话也必须在 —— 否则模型不知道自己在接着干什么 */
    rec(
      '★ 第 2 轮里还能看到那句诉求',
      messages.some((m) => m.role === 'user' && String(m.content ?? '').includes('12 个探测文件')),
      messages.filter((m) => m.role === 'user').length + ' 条 user',
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
console.log(
  appLog.includes('Error') ? `\n（应用日志里有 Error，见 data/unit-test-data/logs）` : '',
)
process.exit(passed === results.length ? 0 : 1)
