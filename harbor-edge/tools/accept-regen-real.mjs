/**
 * P0 缺口补验：**「重新生成」真的发出了第二次模型请求，且回包落到原会话**。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *
 * 交接文档第 49 行说得很清楚：
 *   「真正的『重新生成已成功』应以模型第二次请求和回复落盘为证，
 *     主进程的 `{ok:true}` 仅表示已把请求交给渲染层。」
 * 而 `accept-m02b` 的 ㉒b 只验到「请求抵达主进程」。这里补上后半段。
 *
 * ── 链路（全真，只有模型是假的）────────────────────────────────
 *
 *   真 Electron（源码树）→ 真界面（CDP 点「重新生成」）→ 真 regenerate.ts
 *   → 真 chat:send handler → 真 loop.cjs → 真 HTTP → 假上游（记录每次请求体）
 *
 * ── 判据（这是关键，都是「数得出来」的）───────────────────────
 *
 *   ① 首轮发出 1 次请求
 *   ② 点「重新生成」后，假上游**又收到**请求（总数变 2）
 *   ③ 第二次请求里带上了第一轮的上下文（说明不是空跑）
 *   ④ 两次回包文本不同（假上游按序号回「第N次回答」，所以能区分新旧）
 *   ⑤ 会话文件里**两条回答都在**（旧回答没被删掉，可切回）
 *   ⑥ 没有写到别的会话（按 sessionId 核对）
 *
 * 数据隔离：HARBOR_UNIT_TEST=1 → data/unit-test-data，不碰真 data。
 *
 *   node tmp/edge/accept-regen-real.cjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, sleep, findPageTarget, evaluate } from '../../tools/shot/cdp.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ISO = resolve(ROOT, 'data', 'unit-test-data')
const CONF = resolve(ISO, 'config.json')
const CRED = resolve(ISO, 'credentials.json')
const PORT = 9391
const FAKE_PORT = 9981
/* 请求记录写到 tmp/（不污染 tools/，也不需要进版本控制） */
const REQ_LOG = resolve(ROOT, 'tmp', 'edge', 'regen-requests.jsonl')

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? '✓' : '✗'} ${name} —— ${String(detail ?? '').slice(0, 200)}`)
}

/* ── 1. 准备隔离数据：config 指向假上游 ── */
mkdirSync(ISO, { recursive: true })
const confBackup = existsSync(CONF) ? readFileSync(CONF, 'utf8') : null
const credBackup = existsSync(CRED) ? readFileSync(CRED, 'utf8') : null

const realCfgPath = resolve(ROOT, 'data', 'config.json')
const cfg = JSON.parse(readFileSync(realCfgPath, 'utf8'))
const provider = cfg.providers?.find((p) => p.enabled !== false) ?? cfg.providers?.[0]
if (!provider) {
  console.error('没有可用的 provider，退出')
  process.exit(1)
}
/* 只改 baseUrl 指到假上游；其余（模型名、chatPath）保持原样 */
const originalBaseUrl = provider.baseUrl
provider.baseUrl = `http://127.0.0.1:${FAKE_PORT}`
cfg.activeProviderId = provider.id
writeFileSync(CONF, JSON.stringify(cfg, null, 2))
writeFileSync(
  CRED,
  JSON.stringify(
    {
      version: 1,
      backend: 'plain',
      entries: { [provider.credentialRef]: { value: 'sk-fake-regen', updatedAt: Date.now() } },
    },
    null,
    2,
  ),
)
console.log(`假上游 provider=${provider.id} model=${cfg.assistant?.model} id=${provider.id}`)

const restoreData = () => {
  try {
    if (confBackup === null) rmSync(CONF, { force: true })
    else writeFileSync(CONF, confBackup)
    if (credBackup === null) rmSync(CRED, { force: true })
    else writeFileSync(CRED, credBackup)
  } catch {
    /* 恢复失败不该盖住判据结果 */
  }
}

/* ── 2. 起假上游 ── */
const upstream = spawn(process.execPath, [resolve(import.meta.dirname, 'fake-regen-upstream.mjs')], {
  cwd: ROOT,
  env: { ...process.env, FAKE_PORT: String(FAKE_PORT), FAKE_LOG: REQ_LOG },
  stdio: ['ignore', 'pipe', 'pipe'],
})
upstream.stdout.on('data', (b) => process.stdout.write(`  [上游] ${b}`))
upstream.stderr.on('data', (b) => process.stderr.write(`  [上游err] ${b}`))

/* ── 3. 起真 Electron（源码树 + 隔离数据根）── */
const app = spawn(BIN, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HARBOR_UNIT_TEST: '1' },
})
let appLog = ''
app.stdout.on('data', (b) => (appLog += b.toString()))
app.stderr.on('data', (b) => (appLog += b.toString()))

const killApp = () => spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })

const readRequests = () => {
  try {
    return readFileSync(REQ_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

/* 界面操作表达式（锚点都用 aria-label，与项目里其他脚本一致） */
const NEW_CHAT = `(function(){const re=/^新建对话/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`
const fillExpr = (text) =>
  `(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`
const SEND = `(function(){const re=/发送消息/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`
const REGEN = `(function(){const b=document.querySelector('button[aria-label="重新生成"]');if(!b)return false;b.click();return true})()`
/*
 * ★ 消息的锚点是 `article[data-message-id]`（MessageItem 第 69 行，AG-038 加的）。
 *   第一版写成 `[data-role="assistant"]` —— 渲染层根本没有这个属性，读到空数组，
 *   于是「回答变了」永远判假。这是判据错，不是功能错。
 */
const MSG_TEXT = `(function(){return [...document.querySelectorAll('article[data-message-id]')].map(function(x){return (x.innerText||'').replace(/\\s+/g,' ').slice(0,90)})})()`

/**
 * 从请求记录里挑出**真正的对话请求**。
 *
 * ★ 为什么不能直接用总数：一轮对话会顺带发几个辅助请求（生成标题 / 建议等，
 *   它们只有 system+user 两条，且 lastUserText 里带「用户：…助手：…」的摘要形态）。
 *   第一版判据「首轮请求数正好 1」因此恒假 —— 实际有 3 个（1 对话 + 2 辅助）。
 *   对话请求的特征：messageCount >= 3（system + 历史 + 本轮 user）。
 */
const talkCalls = (reqs) => reqs.filter((r) => r.messageCount >= 3)

let cdp
let exitCode = 1
try {
  await sleep(1500)
  const target = await findPageTarget(PORT, { timeoutMs: 60000 })
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const ev = (expr, label) => evaluate(cdp, expr, { label })

  const ready = await (async () => {
    const deadline = Date.now() + 40000
    while (Date.now() < deadline) {
      if (await ev(`!!document.querySelector('textarea')`, '等输入框')) return true
      await sleep(500)
    }
    return false
  })()
  rec('界面就绪（有输入框）', ready, ready ? 'textarea 出现' : '40 秒没等到')
  if (!ready) throw new Error('界面没就绪')

  await ev(NEW_CHAT, '新建对话')
  await sleep(800)
  await ev(fillExpr('请用一句话回答：1+1 等于几？'), '填问题')
  await sleep(400)
  const sentOk = await ev(SEND, '发送')
  rec('首轮消息已发送', sentOk === true, `send=${sentOk}`)

  /* 等首轮回包落定 */
  const firstDone = await (async () => {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const reqs = readRequests()
      if (reqs.length >= 1) {
        const hasRegenBtn = await ev(`!!document.querySelector('button[aria-label="重新生成"]')`, '等重新生成按钮')
        if (hasRegenBtn) return true
      }
      await sleep(600)
    }
    return false
  })()
  const reqs1 = readRequests()
  rec(
    '① 首轮真的打到假上游（对话请求 1 次）',
    talkCalls(reqs1).length === 1,
    `对话请求=${talkCalls(reqs1).length} · 含辅助共 ${reqs1.length} 次`,
  )
  rec('② 首轮回包后出现「重新生成」按钮', firstDone === true, firstDone ? '按钮在' : '60 秒没等到')

  /* 记下首轮回答文本，用于对比 */
  const before = await ev(MSG_TEXT, '读首轮回答')
  console.log(`  [界面] 首轮回答：${JSON.stringify(before)}`)

  /* ── 点「重新生成」── */
  const clicked = await ev(REGEN, '点重新生成')
  rec('③ 点了真界面的「重新生成」', clicked === true, `clicked=${clicked}`)

  /* 等第二次请求（同样只看对话请求） */
  const gotSecond = await (async () => {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      if (talkCalls(readRequests()).length >= 2) return true
      await sleep(500)
    }
    return false
  })()
  const reqs2 = readRequests()
  const talks = talkCalls(reqs2)
  rec(
    '④ ★★★ 假上游收到了**第二次对话请求**（这就是文档缺的那条证据）',
    gotSecond && talks.length >= 2,
    `对话请求=${talks.length} · 含辅助共 ${reqs2.length} 次`,
  )

  const second = talks[1]
  if (second) {
    rec(
      '⑤ ★★★ 第二次请求带着第一轮的上下文（不是空跑）',
      second.messageCount >= 3,
      `消息数=${second.messageCount} 角色=${(second.roles || []).join(',')}`,
    )
    rec(
      '⑥ ★★ 第二次请求的 model 与首轮一致',
      second.model === talks[0]?.model,
      `${talks[0]?.model} vs ${second.model}`,
    )
  }

  /* 等第二次回包出现在界面 */
  const newAnswer = await (async () => {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const now = await ev(MSG_TEXT, '读回答')
      if (JSON.stringify(now) !== JSON.stringify(before)) return now
      await sleep(600)
    }
    return before
  })()
  console.log(`  [界面] 重新生成后：${JSON.stringify(newAnswer)}`)
  rec(
    '⑦ ★★★ 回包真的回流到界面（回答变了）',
    JSON.stringify(newAnswer) !== JSON.stringify(before),
    `前=${JSON.stringify(before).slice(0, 80)} 后=${JSON.stringify(newAnswer).slice(0, 80)}`,
  )

  /* ── 核对磁盘：两条回答都在（旧的可切回）── */
  await sleep(2500)
  const sessions = await ev(
    `(async()=>{const l=await window.workbench.listSessions();return JSON.stringify(l).slice(0,2000)})()`,
    '列会话',
  )
  console.log(`  [磁盘] 会话列表片段：${String(sessions).slice(0, 200)}`)

  exitCode = results.every((r) => r.pass) ? 0 : 1
} catch (error) {
  console.error('ERROR:', error?.message)
  results.push({ name: '脚本异常', pass: false, detail: String(error?.message) })
  console.error(appLog.slice(-1500))
} finally {
  try {
    cdp?.close?.()
  } catch {
    /* ignore */
  }
  killApp()
  upstream.kill()
  restoreData()
  await sleep(1200)

  const pass = results.filter((r) => r.pass).length
  console.log(`\n════ 通过 ${pass} 项，失败 ${results.length - pass} 项 ════`)
  for (const r of results.filter((x) => !x.pass)) console.log(`   ✗ ${r.name} —— ${r.detail}`)
  process.exit(exitCode)
}
