/*
 * 真机端到端：**真实上游**跑一轮对话（默认 DeepSeek 官方），确认这台机器上
 * 配置里的真实 Key 能拿到真实回复。
 *
 * 与 `e2e-fail-streak.mjs` 的区别（那一份是「链路全真、模型是假的」）：
 *   · **不**设 HARBOR_UNIT_TEST → 数据根是**真实** `data/`（读真 config、用 safeStorage 解真 Key）
 *   · **不**起假上游 → 请求真的发到 `providers[].baseUrl`（真实联网、真实扣费）
 *   · 唯一假的是输入框里那句话 —— 一句「不要调用工具」的短问，避免引出权限卡/工具轮
 *
 * 判据（三条，缺一不算过）：
 *   ① 界面出现**非空助手回复**（`article[data-message-id]` 里非用户那条的正文）
 *   ② 主进程日志新增一行「请求模型… → <baseUrl><chatPath>」—— 证明请求真的打到了配置里的地址
 *   ③ 截图 `shots/electron/real-api.png`
 *
 * ★ 安全阀：**不带 `--yes` 只做只读预检**（读配置、报会调用哪个地址/哪个模型、有没有 Key），
 *   不 spawn Electron、不发任何请求。带 `--yes` 才真跑 —— 那一步会真实联网并扣费。
 *
 *   node tools/e2e-real-api.mjs          # 预检（不联网）
 *   node tools/e2e-real-api.mjs --yes    # 真发（真实联网 + 扣费）
 *
 * ★ 副作用（真实数据根，必须知道）：会在真实 `data/sessions` 里留下一条测试会话，
 *   日志里多几行。脚本**不删**这些（删用户数据比留一条测试会话更危险），结束时把新增文件报出来。
 * ★ 只杀自己起的那个 Electron 进程树（按 PID），不按映像名杀 —— 别碰用户正开着的实例。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, sleep, findPageTarget, evaluate } from './shot/cdp.mjs'
import { autoAnswerCards } from './shot/cards.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DATA = resolve(ROOT, 'data')
const CONF = resolve(DATA, 'config.json')
const CRED = resolve(DATA, 'credentials.json')
const SESS = resolve(DATA, 'sessions')
const PORT = 9388
const SHOT = resolve(ROOT, 'shots', 'electron', 'real-api.png')
const YES = process.argv.includes('--yes')
/** 真实上游比假上游慢得多：等回复给足 180 秒 */
const WAIT_MS = 180_000
const PROMPT = '只回答一句话，不要调用任何工具：1+1 等于几？'

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? '✓' : '✗'} ${name} —— ${detail}`)
}

/* ── 1. 只读预检：真实配置里到底会发给谁 ── */
if (!existsSync(CONF)) {
  console.log(`✗ 找不到真实配置：${CONF}`)
  process.exit(1)
}
const cfg = JSON.parse(readFileSync(CONF, 'utf8'))
const model = String(cfg?.assistant?.model ?? '').trim()
const providers = Array.isArray(cfg?.providers) ? cfg.providers : []
/** 与内核同口径：先按模型找「声明提供它」的供应商，找不到退回活跃/第一个 */
const provider =
  providers.find((p) => p?.enabled && Array.isArray(p.models) && p.models.includes(model)) ??
  providers.find((p) => p?.enabled && p.id === 'deepseek') ??
  providers.find((p) => p?.enabled) ??
  providers[0]
if (!provider) {
  console.log('✗ 配置里没有可用供应商')
  process.exit(1)
}
const baseUrl = String(provider.baseUrl ?? '').trim()
const chatPath = String(provider.chatPath ?? '/chat/completions')
const url = `${baseUrl.replace(/\/+$/, '')}${chatPath.startsWith('/') ? chatPath : `/${chatPath}`}`
const ref = String(provider.credentialRef ?? '')

/** 凭证只报「有没有」，**绝不打印值** */
let credBackend = '无'
try {
  const cred = JSON.parse(readFileSync(CRED, 'utf8'))
  const entry = cred?.entries?.[ref]
  credBackend = entry ? String(cred?.backend ?? 'plain') : '无（这个 ref 没存过 Key）'
} catch {
  credBackend = '读不到 credentials.json'
}

const today = (() => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
})()
const LOG = resolve(DATA, 'logs', `${today}.log`)
const logOffset = (() => {
  try {
    return statSync(LOG).size
  } catch {
    return 0
  }
})()
/** 只读「本次启动之后」新增的日志（按字节切，别用字符串下标） */
const newLogText = () => {
  try {
    return readFileSync(LOG).subarray(logOffset).toString('utf8')
  } catch {
    return ''
  }
}

console.log('预检（只读，没有发任何请求）')
console.log(`  数据根    ${DATA}${existsSync(resolve(DATA, 'unit-test-data')) ? '（注意：目录里有 unit-test-data，但本脚本不设 HARBOR_UNIT_TEST，仍走真实根）' : ''}`)
console.log(`  供应商    ${provider.id} / ${provider.name ?? ''}`)
console.log(`  模型      ${model || '(未设置)'}`)
console.log(`  请求地址  ${url}`)
console.log(`  凭证      ${ref} → ${credBackend}`)
console.log(`  提示词    ${PROMPT}`)

if (!YES) {
  console.log('\n未带 --yes：只做了预检，**没有**发起真实请求。')
  console.log('真跑（真实联网 + 扣费）：node tools/e2e-real-api.mjs --yes')
  process.exit(0)
}
if (!baseUrl) {
  console.log('\n✗ 这个供应商没有 baseUrl，发不出去')
  process.exit(1)
}
if (!/^https?:\/\//i.test(url)) {
  console.log(`\n✗ 请求地址不像 http(s)：${url}`)
  process.exit(1)
}
if (credBackend.startsWith('无')) {
  console.log('\n✗ 凭证库里没有这个供应商的 Key —— 先在界面上填一次，再跑这个脚本')
  process.exit(1)
}
if (!existsSync(BIN)) {
  console.log(`\n✗ 找不到 Electron：${BIN}（先 npm install）`)
  process.exit(1)
}

/* ── 2. 起源码树 Electron：**真实数据根**（不设 HARBOR_UNIT_TEST） ── */
const before = (() => {
  try {
    return new Set(readdirSync(SESS))
  } catch {
    return new Set()
  }
})()

const env = { ...process.env }
delete env.HARBOR_UNIT_TEST
delete env.VITE_DEV_SERVER_URL
const app = spawn(BIN, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env,
})
let appLog = ''
app.stdout.on('data', (b) => {
  appLog += b.toString()
})
app.stderr.on('data', (b) => {
  appLog += b.toString()
})
const killApp = () => spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })

const NEW_CHAT = `(function(){const re=/^新建对话/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`
const fillExpr = (text) =>
  `(function(){const ta=document.querySelector('textarea')||document.querySelector('[aria-label="消息输入框"]');if(!ta)return 0;const proto=Object.getPrototypeOf(ta);const s=Object.getOwnPropertyDescriptor(proto,'value').set;s.call(ta, ${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`
const SEND = `(function(){const b=document.querySelector('button[aria-label="发送消息"]');if(!b||b.disabled)return false;b.click();return true})()`
/** 读「最后一条助手消息」的正文 + 是否有报错块 + 是否还在生成 */
const READ_REPLY = `(function(){
  const arts=[...document.querySelectorAll('article[data-message-id]')];
  const asst=arts.filter(a=>!(a.className||'').includes('items-end'));
  const texts=asst.map(a=>(a.innerText||'').trim()).filter(Boolean);
  const errors=[...document.querySelectorAll('[role="alert"]')].map(e=>(e.innerText||'').trim()).filter(Boolean);
  return { texts, error: errors.join(' | ').slice(0,600), sending: !!document.querySelector('button[aria-label="停止生成"]') };
})()`

let cdp
let reply = ''
let failure = ''
try {
  console.log('\n启动源码树 Electron（真实数据根，不加隔离开关）…')
  await sleep(1500)
  const target = await findPageTarget(PORT, { timeoutMs: 60_000 })
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const ev = (expr, label) => evaluate(cdp, expr, { label })

  const ready = await (async () => {
    const deadline = Date.now() + 40_000
    while (Date.now() < deadline) {
      if (await ev(`!!document.querySelector('textarea')`, '等输入框')) return true
      await sleep(500)
    }
    return false
  })()
  rec('界面就绪（有输入框）', ready, ready ? 'textarea 出现' : '40 秒没等到（dist 没构建？先 npm run build）')
  if (!ready) throw new Error('界面没起来')

  await ev(NEW_CHAT, '新建对话')
  await sleep(1200)
  const typed = await ev(fillExpr(PROMPT), '填输入框')
  rec('输入框可写', typed === PROMPT.length, `写入 ${typed} 字`)
  await sleep(400)
  const sent = await ev(SEND, '点发送')
  rec('发送按钮可点', sent === true, sent ? '已点发送（真实请求即将发出）' : '没找到可用的发送按钮')
  if (!sent) throw new Error('发送按钮不可用')

  /* ── 3. 等真实回复（顺手把澄清卡/确认卡点掉，别让脚本自己卡住） ── */
  const deadline = Date.now() + WAIT_MS
  let last = ''
  let stable = 0
  let cardsHandled = 0
  while (Date.now() < deadline) {
    const cards = await autoAnswerCards(cdp, { timeoutMs: 1200, maxCards: 2 })
    cardsHandled += cards.handled || 0
    const state = await ev(READ_REPLY, '读回复')
    const text = state?.texts?.join('\n\n').trim() ?? ''
    if (state?.error && !text) {
      failure = state.error
      break
    }
    if (text && text === last) stable += 1
    else {
      last = text
      stable = 0
    }
    /* 有内容、且连续 3 次采样没变（约 4.5 秒）= 这条写完了 */
    if (text && stable >= 3) break
    await sleep(1500)
  }
  reply = last
  if (cardsHandled > 0) console.log(`  （顺手点掉了 ${cardsHandled} 张交互卡）`)

  rec(
    '★ 真实 API 返回内容',
    Boolean(reply) && !failure,
    failure ? `界面上是报错块：${failure}` : reply ? `${reply.length} 字` : '等 180 秒仍没有助手正文',
  )

  /* ── 4. 日志证据：这一次的请求真的打到了配置里的地址 ── */
  const fresh = newLogText()
  const hit = fresh
    .split('\n')
    .filter((line) => line.includes(url))
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
  rec(
    `★ 日志出现指向 ${url} 的请求记录`,
    hit.length > 0,
    hit[0] ?? '新增日志里没找到（看 data/logs 里有没有 ERROR）',
  )
  const modelLine = fresh.split('\n').find((line) => /请求模型/.test(line) && line.includes(url))
  if (modelLine) console.log(`  真实模型名：${(modelLine.match(/请求模型.*$/)?.[0] ?? modelLine).trim()}`)
  if (reply) console.log(`  回复前 120 字：${reply.replace(/\s+/g, ' ').slice(0, 120)}`)

  /* ── 5. 截图 ── */
  await sleep(1200)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(resolve(ROOT, 'shots', 'electron'), { recursive: true })
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
  const shotOk = existsSync(SHOT) && statSync(SHOT).size > 1024
  rec('截图生成', shotOk, `${SHOT}（${shotOk ? statSync(SHOT).size : 0} 字节）`)
} catch (error) {
  const why = error instanceof Error ? error.message : String(error)
  console.error('E2E 失败：', why)
  rec('E2E 跑通', false, why)
  const tail = appLog.trim().split('\n').slice(-8).join('\n')
  if (tail) console.error(`Electron 尾巴：\n${tail}`)
} finally {
  try {
    cdp?.ws.close()
  } catch {
    /* ignore */
  }
  killApp()
}

/* 真实数据根里多出来的东西 —— 报出来，不替用户删 */
try {
  const added = readdirSync(SESS).filter((name) => !before.has(name))
  if (added.length > 0) console.log(`\n真实数据里新增的会话文件（不会自动删）：${added.join('、')}`)
} catch {
  /* ignore */
}

const passed = results.filter((r) => r.pass).length
console.log(`\n${passed === results.length ? '✅ 全过' : '❌ 有失败'}（${passed}/${results.length}）`)
process.exit(passed === results.length ? 0 : 1)
