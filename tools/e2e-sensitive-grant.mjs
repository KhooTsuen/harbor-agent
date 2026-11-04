/*
 * 真机端到端：**用户批准敏感文件之后，到底读没读到**（C-1）
 *
 * 为什么要有它：C-1 的主诉是「点了允许还是读不到」。自检组能验内核判据，
 * 但验不了「真界面 → 真确认卡 → 点允许 → 工具真的把内容读出来」这条完整链。
 *
 * 链路全真，只有模型是假的：
 *   真 Electron（源码树）→ 真界面 → 真 chat handler → 真 loop → 真 read_file
 *   → 真确认卡 → **脚本自己点「允许」** → 授权落盘 → 重试 → 内容回来 → 上游收到第 2 个请求
 *
 * 判据（最强的一条）：**假上游收到的第 2 个请求体里，带着那个假密钥**。
 *   读不到的话工具只会把「错误：需要授权才能访问…」喂回模型，密钥永远不会出现。
 *
 * 数据隔离：Electron 带 HARBOR_UNIT_TEST=1 → 数据根切 data/unit-test-data，
 *          敏感文件本身也造在那儿，**完全不碰用户真实凭据**。
 *
 *   node tools/e2e-sensitive-grant.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, sleep, findPageTarget, evaluate } from './shot/cdp.mjs'
import { NEW_CHAT, SEND } from './shot/ui-selectors.mjs'
import { autoAnswerCards, CARDS } from './shot/cards.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ISO = resolve(ROOT, 'data', 'unit-test-data')
const CONF = resolve(ISO, 'config.json')
const CRED = resolve(ISO, 'credentials.json')
const CAPS = resolve(ISO, 'capabilities.json')
const SECRET_FILE = resolve(ISO, 'e2e-sensitive', '.env')
const SECRET = 'sk-c1-e2e-should-be-readable'
/** 假上游把请求体追加到这里 */
const DUMP = resolve(ROOT, 'data', 'unit-test-data', 'e2e-sensitive-requests.log')
const PORT = 9388
const FAKE_PORT = 9984
const SHOT = resolve(ROOT, 'shots', 'electron', 'e2e-sensitive-grant.png')

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? '✓' : '✗'} ${name} —— ${detail}`)
}

/* ── 1. 造隔离数据：假敏感文件 + config 指向假上游 ── */
mkdirSync(resolve(ISO, 'e2e-sensitive'), { recursive: true })
writeFileSync(SECRET_FILE, `SECRET=${SECRET}\n`, 'utf8')

mkdirSync(ISO, { recursive: true })
const confBackup = existsSync(CONF) ? readFileSync(CONF, 'utf8') : null
const credBackup = existsSync(CRED) ? readFileSync(CRED, 'utf8') : null
const capsBackup = existsSync(CAPS) ? readFileSync(CAPS, 'utf8') : null

const cfg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'config.json'), 'utf8'))
cfg.providers[0].baseUrl = `http://127.0.0.1:${FAKE_PORT}/v1-sensitive`
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
/* 从「一条授权都没有」开始，否则上一轮的授权会让这次压根不弹卡 */
writeFileSync(CAPS, JSON.stringify({ version: 1, grants: [] }, null, 2))

const restoreData = () => {
  try {
    if (confBackup === null) rmSync(CONF, { force: true })
    else writeFileSync(CONF, confBackup)
    if (credBackup === null) rmSync(CRED, { force: true })
    else writeFileSync(CRED, credBackup)
    if (capsBackup === null) rmSync(CAPS, { force: true })
    else writeFileSync(CAPS, capsBackup)
    rmSync(SECRET_FILE, { force: true })
    rmSync(DUMP, { force: true })
  } catch {
    /* ignore */
  }
}

/* ── 2. 假上游（第 1 轮读那个敏感文件；第 2 轮收尾）── */
const upstream = spawn(process.execPath, [resolve(ROOT, 'tools', 'fake-upstream.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    FAKE_PORT: String(FAKE_PORT),
    FAKE_SENSITIVE_PATH: SECRET_FILE,
    /* 假上游把每个请求体追加到这里 —— 「第 2 个请求里有没有那个密钥」是本次最强判据 */
    FAKE_DUMP_PATH: DUMP,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let upstreamLog = ''
upstream.stdout.on('data', (b) => {
  upstreamLog += b.toString()
})
upstream.stderr.on('data', (b) => process.stderr.write(`  [上游err] ${b}`))
const hits = () => (upstreamLog.match(/mode=sensitive/g) ?? []).length

/* ── 3. 真 Electron（源码树，隔离数据根）── */
const app = spawn(BIN, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HARBOR_UNIT_TEST: '1' },
})
const killApp = () => spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })

const fillExpr = (text) =>
  `(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`

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
  await ev(fillExpr('读一下那个配置'), '填输入框')
  await sleep(400)
  const sent = await ev(SEND, '点发送')
  rec('发送按钮可点', sent === true, sent ? '已点发送' : '没找到发送按钮')

  /* ★ 第一步：确认卡必须弹出来（敏感文件要用户点头） */
  const cardSeen = await waitFor(async () => {
    const c = await ev(
      `(function(){const el=[...document.querySelectorAll('section[aria-label="${CARDS.confirm}"]')].find(s=>s.offsetParent!==null);return el?{label:el.getAttribute('aria-label'),text:(el.textContent||'').slice(0,120)}:null})()`,
      '读确认卡',
    )
    return c
  }, 40000)
  rec(
    '★ 敏感文件的确认卡弹出来了',
    Boolean(cardSeen),
    cardSeen ? cardSeen.text.replace(/\s+/g, ' ').slice(0, 90) : '40 秒没等到确认卡',
  )
  if (!cardSeen) throw new Error('确认卡没弹出')

  /* ★ 第二步：脚本自己点「允许」（autoAnswerCards 对确认卡的默认提交按钮就是「允许」） */
  const answered = await autoAnswerCards(ev, { timeoutMs: 20000 })
  rec(
    '★ 脚本自己点了「允许」',
    answered.handled >= 1 && !answered.stuck,
    answered.clicks.map((c) => c.text).join(' → ') || '没点到任何按钮',
  )

  /* ★ 第三步：最强判据 —— 第 2 个请求体里带着那个假密钥 */
  const leaked = await waitFor(async () => {
    if (!existsSync(DUMP)) return false
    return readFileSync(DUMP, 'utf8').includes(SECRET)
  }, 25000, 700)
  rec(
    '★★ 批准之后内容真的读到了（上游第 2 个请求里带着那个假密钥）',
    Boolean(leaked),
    leaked ? '请求体里出现了密钥' : '25 秒内没在上游请求里看到密钥',
  )

  rec(
    '对话继续了（上游收到第 2 个请求）',
    hits() >= 2,
    `上游请求数 = ${hits()}`,
  )

  /* 授权落盘的样子也读一眼（不许是「说不清归属」的那种记录） */
  const caps = JSON.parse(readFileSync(CAPS, 'utf8'))
  const mine = (caps.grants ?? []).filter((g) => String(g.path).includes('.env'))
  rec(
    '授权落的是那个文件的精确路径',
    mine.length >= 1 && mine.every((g) => String(g.path).endsWith('.env')),
    JSON.stringify(mine.map((g) => ({ path: g.path, mode: g.mode, hasSession: Boolean(g.sessionId) }))),
  )

  await sleep(1500)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(resolve(ROOT, 'shots', 'electron'), { recursive: true })
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
  console.log(`  截图 → ${SHOT}`)
} catch (error) {
  console.error('E2E 失败：', error instanceof Error ? error.message : error)
  rec('E2E 跑通', false, String(error))
} finally {
  try {
    cdp?.close?.()
  } catch {
    /* ignore */
  }
  killApp()
  upstream.kill()
  await sleep(800)
  restoreData()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) {
    console.log('失败：')
    for (const f of failed) console.log(`  · ${f.name}`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}
