/**
 * 真机验收 ③：ContextGauge 真的显示、且数字与内核一致。
 *
 * 链路全真：真 Electron（源码树）→ 真界面 → 真 chat → 真 loop → 真 HTTP → 假上游。
 * 判据：
 *   ① 用量圈存在且有可访问文案（不是「看不见」）
 *   ② 文案里同时有「理论量」和「上一轮内核实际组装」（后者证明 turn_start.input 接通了）
 *   ③ 实际组装那行里的对话层用量不超过它的额度（预算没管住就会超）
 *
 * 数据隔离：HARBOR_UNIT_TEST=1 → data/unit-test-data，不碰真 data。
 *
 *   node tools/e2e-context-gauge.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, findPageTarget, sleep, evaluate } from './shot/cdp.mjs'
import { NEW_CHAT, SEND } from './shot/ui-selectors.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ISO = resolve(ROOT, 'data', 'unit-test-data')
const CONF = resolve(ISO, 'config.json')
const CRED = resolve(ISO, 'credentials.json')
const PORT = 9381
const FAKE_PORT = 9982
const DUMP = resolve(ROOT, 'data', 'unit-test-data', 'gauge-requests.jsonl')

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

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? '✓' : '✗'} ${name} —— ${detail}`)
}

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
rmSync(DUMP, { force: true })

const upstream = spawn(process.execPath, [resolve(ROOT, 'tools', 'fake-upstream-context.mjs')], {
  cwd: ROOT,
  env: { ...process.env, FAKE_PORT: String(FAKE_PORT), FAKE_DUMP_PATH: DUMP },
  stdio: ['ignore', 'pipe', 'pipe'],
})
upstream.stdout.on('data', (b) => process.stdout.write(`  [上游] ${b}`))
upstream.stderr.on('data', (b) => process.stderr.write(`  [上游err] ${b}`))

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

/** 读那个用量圈的 aria-label（它就是 tooltip 全文） */
const GAUGE = `(() => {
  const el = document.querySelector('[role="status"][aria-label*="上下文"]')
  return el ? el.getAttribute('aria-label') : ''
})()`

const fillExpr = (text) => `(() => {
  const ta = document.querySelector('textarea')
  if (!ta) return 0
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, ${JSON.stringify(text)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return ta.value.length
})()`

let cdp = null
try {
  await sleep(1500)
  const target = await findPageTarget(PORT, { timeoutMs: 45000 })
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const ev = (expr, label) => evaluate(cdp, expr, { label })

  /* 等界面 */
  const ready = await (async () => {
    for (let i = 0; i < 60; i += 1) {
      const ok = await ev(`Boolean(document.querySelector('textarea'))`, 'probe')
      if (ok) return true
      await sleep(500)
    }
    return false
  })()
  rec('界面就绪', ready, ready ? 'textarea 出现' : '30 秒没等到')
  if (!ready) throw new Error('界面没起来')

  const before = await ev(GAUGE, '读用量圈')
  rec('★ 用量圈存在且有可访问文案', Boolean(before && before.includes('上下文')), before ? `${before.length} 字` : '没找到')

  await ev(NEW_CHAT, '新建对话')
  await sleep(1200)
  await ev(fillExpr('把那 12 个探测文件都读一遍'), '填输入框')
  await sleep(300)
  await ev(SEND, '点发送')

  /* 等这一轮收尾（第 2 轮请求之后还有标题/建议两条附带请求，多等一会） */
  const deadline = Date.now() + 90000
  let after = ''
  while (Date.now() < deadline) {
    await sleep(1500)
    after = await ev(GAUGE, '读用量圈')
    if (after && after.includes('上一轮内核')) break
  }

  rec('★ 用量圈在真实一轮之后仍在（没被异常打断）', Boolean(after && after.includes('上下文')), after ? `${after.length} 字` : '空')
  const hasTheory = after.includes('上下文') && /估算 [\d,]+ \/ [\d,]+ token/.test(after)
  rec('★ 显示理论量（压缩点之后要发多少）', hasTheory, (after.match(/上下文 \d+%[^\n]*/) ?? [''])[0].slice(0, 60))
  const wired = after.includes('上一轮内核')
  rec('★★ 显示「上一轮内核实际组装」（证明 turn_start.input 接通了）', wired, wired ? (after.match(/上一轮内核[^\n]*/) ?? [''])[0].slice(0, 90) : '没有这一段 —— 没接通')

  if (wired) {
    const m = /对话层 ([\d,]+) \/ ([\d,]+) 字符/.exec(after)
    if (m) {
      const used = Number(m[1].replace(/,/g, ''))
      const budget = Number(m[2].replace(/,/g, ''))
      rec('★★ 实际组装量不超过对话层额度（预算管住了）', used <= budget, `${used} / ${budget} = ${Math.round((used / budget) * 100)}%`)
      /*
       * 「装了多少」要和**真实发出去的那份**比，不能凭空要求「必须很大」。
       * 这一轮开始时历史只有用户那一句，对话层本来就该是几十字符 ——
       * 拿真实请求体（第 1 轮 dump）里的非 system 消息量对照，量级对得上才算数。
       */
      const dump = dumpOf(1)
      if (dump) {
        const body = JSON.parse(dump)
        const convoChars = (body.messages ?? [])
          .filter((x) => x.role !== 'system')
          .reduce((sum, x) => sum + JSON.stringify(x).length, 0)
        const ratio = used > 0 ? convoChars / used : 0
        rec(
          '★★ 界面显示的对话层量 ≈ 真实请求体里的非 system 部分（同一量级）',
          used > 0 && ratio > 0.5 && ratio < 3,
          `界面 ${used} 字符 / 请求体 ${convoChars} 字符（比值 ${ratio.toFixed(2)}）`,
        )
      } else {
        rec('读到第 1 轮请求体用于对照', false, '没有 dump')
      }
    } else {
      rec('解析实际组装那行', false, after.slice(-160))
    }
  }
  rec('界面没有未捕获异常', !/Uncaught|TypeError|ReferenceError/.test(appLog), appLog.includes('Error') ? '日志里有 Error' : '干净')
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
process.exit(passed === results.length ? 0 : 1)
