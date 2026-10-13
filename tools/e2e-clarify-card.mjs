/*
 * 真机端到端：验证「自动化测试脚本会自己点交互卡」——**弹卡不再把脚本卡死**。
 *
 * 为什么有这个脚本（2026-10-14 实测的盲区）：
 *   CDP 脚本能自己填输入框、点发送，但界面弹出**提问卡 / 确认卡**时它不知道点哪儿 ——
 *   A/B 里有几条场景就是这么卡住的：看着像「模型没选对工具」，其实是脚本不会往下走。
 *
 * 链路全真，只有模型是假的：
 *   真 Electron（源码树）→ 真界面 → 真 chat handler → 真 loop → 真 ask_user 工具
 *   → 真澄清卡（ClarifyCard）→ **脚本自己检测 + 点击** → 答复回给上游 → 对话继续。
 *
 * 判据（最强的一条）：**假上游收到了第 2 个请求**。
 *   第 1 个请求 = 模型第一次回答（要 ask_user）；澄清卡弹出来、脚本答完、
 *   工具结果喂回去之后，才会有第 2 个请求。卡没答 → 永远停在第 1 个。
 *
 * 数据隔离：给 Electron 传 HARBOR_UNIT_TEST=1 → 数据根切 data/unit-test-data，
 *          **完全不碰**仓库真 data。
 *
 *   node tools/e2e-clarify-card.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, sleep, findPageTarget, evaluate } from './shot/cdp.mjs'
import { autoAnswerCards, CARDS } from './shot/cards.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ISO = resolve(ROOT, 'data', 'unit-test-data')
const CONF = resolve(ISO, 'config.json')
const CRED = resolve(ISO, 'credentials.json')
const PORT = 9378
const FAKE_PORT = 9982
const SHOT = resolve(ROOT, 'shots', 'electron', 'e2e-clarify-card.png')

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? '✓' : '✗'} ${name} —— ${detail}`)
}

/* ── 1. 隔离数据：config 指向假上游（ask 模式）+ 假凭证 ── */
mkdirSync(ISO, { recursive: true })
const confBackup = existsSync(CONF) ? readFileSync(CONF, 'utf8') : null
const credBackup = existsSync(CRED) ? readFileSync(CRED, 'utf8') : null
const cfg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'config.json'), 'utf8'))
cfg.providers[0].baseUrl = `http://127.0.0.1:${FAKE_PORT}/v1-ask`
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

/* ── 2. 假上游（ask 模式：第 1 轮 ask_user → 澄清卡；第 2 轮收尾）── */
const upstream = spawn(process.execPath, [resolve(ROOT, 'tools', 'fake-upstream.mjs')], {
  cwd: ROOT,
  env: { ...process.env, FAKE_PORT: String(FAKE_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let upstreamLog = ''
upstream.stdout.on('data', (b) => {
  upstreamLog += b.toString()
})
upstream.stderr.on('data', (b) => process.stderr.write(`  [上游err] ${b}`))
const upstreamHits = () => (upstreamLog.match(/mode=ask/g) ?? []).length

/* ── 3. 真 Electron（源码树，隔离数据根）── */
const app = spawn(BIN, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HARBOR_UNIT_TEST: '1' },
})
const killApp = () => spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })

const NEW_CHAT = `(function(){const re=/^新建对话/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`
const fillExpr = (text) =>
  `(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`
const SEND = `(function(){const re=/发送消息/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`

const waitFor = async (fn, timeoutMs, intervalMs = 600) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await sleep(intervalMs)
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

  const ready = await waitFor(() => ev(`!!document.querySelector('textarea')`, '等输入框'), 30000, 500)
  rec('界面就绪（有输入框）', Boolean(ready), ready ? 'textarea 出现' : '30 秒没等到')
  if (!ready) throw new Error('界面没起来')

  await ev(NEW_CHAT, '新建对话')
  await sleep(1200)
  const typed = await ev(fillExpr('帮我改一下这个项目'), '填输入框')
  rec('输入框可写', typed === '帮我改一下这个项目'.length, `写入 ${typed} 字`)
  await sleep(400)
  const sent = await ev(SEND, '点发送')
  rec('发送按钮可点', sent === true, sent ? '已点发送' : '没找到发送按钮')

  /* ★ 核心：等澄清卡弹出 → 脚本自己检测 → 自动点「选项 + 提交」 */
  const cardSeen = await waitFor(async () => {
    const c = await ev(
      `(function(){const el=[...document.querySelectorAll('section[aria-label="${CARDS.clarify}"]')].find(s=>s.offsetParent!==null);return el?{label:el.getAttribute('aria-label'),buttons:[...el.querySelectorAll('button')].map(b=>(b.textContent||'').trim().slice(0,20))}:null})()`,
      '读澄清卡',
    )
    return c
  }, 40000)
  rec(
    '★ 澄清卡自动弹出（不再靠人点）',
    Boolean(cardSeen),
    cardSeen ? `aria-label=${cardSeen.label} 按钮=${cardSeen.buttons.join(' / ')}` : '40 秒没等到澄清卡',
  )
  if (!cardSeen) throw new Error('澄清卡没弹出')

  const answered = await autoAnswerCards(ev, { choose: '只改这一处', timeoutMs: 15000 })
  rec(
    '★ 脚本自己点掉了卡片（选选项 → 提交）',
    answered.handled >= 1 && !answered.stuck,
    answered.clicks.map((c) => c.text).join(' → ') || '没点到任何按钮',
  )

  const gone = await waitFor(
    async () => !(await ev(`!!document.querySelector('section[aria-label="${CARDS.clarify}"]')`, '读澄清卡')),
    10000,
    400,
  )
  rec('卡片点完就消失了', Boolean(gone), gone ? '澄清卡已消失' : '10 秒后卡还在')

  /* ★ 最强判据：对话继续了 → 假上游收到第 2 个请求 */
  const continued = await waitFor(() => upstreamHits() >= 2, 30000, 600)
  rec(
    '★★ 对话继续了（上游收到第 2 个请求 —— 卡没答就永远停在第 1 个）',
    Boolean(continued),
    `上游请求数 = ${upstreamHits()}`,
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
