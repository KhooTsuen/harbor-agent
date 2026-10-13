/*
 * 真机端到端：验证 CE-011「连续失败 → 替代方案」在**真实界面链路**上生效。
 *
 * 链路全真，只有模型是假的：
 *   真 Electron（源码树）→ 真界面（CDP 点输入框/发送）→ 真 chat handler → 真 loop.cjs
 *   → 真 failure-streak → 真 HTTP 请求 → 假上游（每轮读不同的不存在文件 → 真失败）
 *
 * 判据（最强的一条）：**假上游收到的第 3 个请求体里有没有那句话**。
 * 前 2 轮没有、第 3 轮有 = failure-streak 在第 2 次失败后的轮次边界推了它。
 *
 * 数据隔离：给 Electron 传 HARBOR_UNIT_TEST=1 → 数据根切到 data/unit-test-data，
 *          **完全不碰**仓库的真 data（与 vitest 用同一套隔离开关）。
 *
 *   node tools/e2e-fail-streak.mjs
 *
 * 为什么常驻在 tools/ 而不是 tmp/：它是「**CDP 能力可用**」的活证明 ——
 * 起一个独立实例、连上、驱动真实界面、拿真实请求体验证。以后 UI / 循环 /
 * 提示词相关的改动，它是现成的回归资产（改坏了这里会红）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, sleep, findPageTarget, evaluate } from './shot/cdp.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ISO = resolve(ROOT, 'data', 'unit-test-data')
const CONF = resolve(ISO, 'config.json')
const CRED = resolve(ISO, 'credentials.json')
const PORT = 9377
const FAKE_PORT = 9979
const SHOT = resolve(ROOT, 'shots', 'electron', 'ce011-fail-streak.png')

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? '✓' : '✗'} ${name} —— ${detail}`)
}

/* ── 1. 隔离数据：写 config（指向假上游）+ 假凭证 ── */
mkdirSync(ISO, { recursive: true })
const confBackup = existsSync(CONF) ? readFileSync(CONF, 'utf8') : null
const credBackup = existsSync(CRED) ? readFileSync(CRED, 'utf8') : null
const cfg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'config.json'), 'utf8'))
cfg.providers[0].baseUrl = `http://127.0.0.1:${FAKE_PORT}/v1-fail`
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

/* ── 2. 假上游（fail 模式）── */
const upstream = spawn(process.execPath, [resolve(ROOT, 'tools', 'fake-upstream.mjs')], {
  cwd: ROOT,
  env: { ...process.env, FAKE_PORT: String(FAKE_PORT) },
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

const killApp = () =>
  spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })

const NEW_CHAT = `(function(){const re=/^新建对话/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`
const fillExpr = (text) =>
  `(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`
const SEND = `(function(){const re=/发送消息/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`

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

  await ev(NEW_CHAT, '新建对话')
  await sleep(1200)
  const typed = await ev(fillExpr('帮我读一下这个文件'), '填输入框')
  rec('输入框可写', typed === '帮我读一下这个文件'.length, `写入 ${typed} 字`)
  await sleep(400)
  const sent = await ev(SEND, '点发送')
  rec('发送按钮可点', sent === true, sent ? '已点发送' : '没找到发送按钮')

  /* 等假上游收到「带那句话」的请求（最多 60 秒） */
  const deadline = Date.now() + 60000
  while (Date.now() < deadline && !/已经连续失败」=true/.test(upstreamLog)) await sleep(600)

  const rounds = [...upstreamLog.matchAll(/fail 第 (\d+) 轮 \| 请求体含「已经连续失败」=(\w+)/g)].map(
    (m) => ({ n: m[1], hit: m[2] }),
  )
  rec(
    '★ 第 1 轮请求里**没有**那句话',
    rounds[0]?.hit === 'false',
    rounds[0] ? `第 ${rounds[0].n} 轮 hit=${rounds[0].hit}` : '没有第 1 轮',
  )
  rec(
    '★ 第 2 轮请求里**还没有**（未到阈值 2）',
    rounds[1]?.hit === 'false',
    rounds[1] ? `第 ${rounds[1].n} 轮 hit=${rounds[1].hit}` : '没有第 2 轮',
  )
  rec(
    '★★ 第 3 轮请求里**有**「已经连续失败」（第 2 次失败后推出的）',
    rounds[2]?.hit === 'true',
    rounds[2] ? `第 ${rounds[2].n} 轮 hit=${rounds[2].hit}` : '没有第 3 轮',
  )

  await sleep(2500)
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
  restoreData()
}

const passed = results.filter((r) => r.pass).length
console.log(`\n${passed === results.length ? '✅ 全过' : '❌ 有失败'}（${passed}/${results.length}）`)
process.exit(passed === results.length ? 0 : 1)
