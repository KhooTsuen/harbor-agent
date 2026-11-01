/**
 * 真机端到端：**重试后同一段话不许显示两遍**（2026-10-21 用户报的故障）
 *
 * 链路全真，只有模型是假的：
 *   真 Electron（源码树）→ 真界面（CDP 填输入框 / 点发送）→ 真 chat handler → 真 loop.cjs
 *   → 真 HTTP → 假上游（`retry` 模式：第一次发半截正文后撕连接，第二次返回完整正文）。
 *
 * 撕连接在内核里归为 network 类（可重试），于是 `loop-model.cjs` 会从头重新请求整段 ——
 * 这正是用户截图里那个形状的成因。判据取界面上的**真实文本**：
 *
 *   · 屏幕上那句正文出现 **1 次**（不是 2 次）
 *   · 那半截（不带后半句的版本）**不在**屏幕上
 *   · 完整那句**在**（重试没把内容吞掉）
 *
 * 数据隔离：给 Electron 传 HARBOR_UNIT_TEST=1 → 数据根切到 data/unit-test-data，
 *          完全不碰仓库的真 data。
 *
 *   node tools/e2e-retry-rollback.mjs
 *
 * 为什么常驻在 tools/：它是「重试链路」的回归资产 —— 以后动 streamEvents / loop-model /
 * fake-upstream 都能直接重跑，不用重新搭环境。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, sleep, findPageTarget, evaluate } from './shot/cdp.mjs'
/* 判据文案直接吃假上游那一份常量 —— 手抄一份就等于给自己留个「改一边忘一边」（AGENT.md 第 9 条） */
import { RETRY_FULL as FULL, RETRY_PARTIAL as PARTIAL } from './fake-retry-mode.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ISO = resolve(ROOT, 'data', 'unit-test-data')
const CONF = resolve(ISO, 'config.json')
const CRED = resolve(ISO, 'credentials.json')
const PORT = 9379
const FAKE_PORT = 9981
const SHOT = resolve(ROOT, 'shots', 'electron', 'retry-rollback.png')

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
cfg.providers[0].baseUrl = `http://127.0.0.1:${FAKE_PORT}/v1-retry`
/*
 * ★ 这里**不能**关掉 fallback：`loop-model.cjs:78` 的 `maxAttempts` 就是看 `fb.enabled`
 *   给的 —— 关掉它等于让内核一次都不重试（第一版就这样写错，界面上只剩半截 + terminated）。
 *   默认配置就行：隔离数据里只给 providers[0] 写了凭证，其它供应商 hasKey 为假、
 *   进不了降级候选，所以这次重试一定是「同一个供应商重来」。
 */
delete cfg.fallback
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

/* ── 2. 假上游 ── */
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
const killApp = () => spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })

const NEW_CHAT = `(function(){const re=/^新建对话/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`
const fillExpr = (text) =>
  `(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`
const SEND = `(function(){const re=/发送消息/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`

/** 数屏幕上那段话出现了几次（去掉空白再比，免得被换行干扰） */
const COUNT = (text) =>
  `(function(){const norm=s=>(s||'').replace(/\\s+/g,'');const body=norm(document.body.innerText);const needle=norm(${JSON.stringify(text)});let n=0,at=0;while((at=body.indexOf(needle,at))>=0){n+=1;at+=needle.length}return n})()`
const HAS_PARTIAL_ONLY = `(function(){const norm=s=>(s||'').replace(/\\s+/g,'');const body=norm(document.body.innerText);const partial=norm(${JSON.stringify(PARTIAL)});const full=norm(${JSON.stringify(FULL)});const rest=body.split(partial).join('');return rest.includes(partial.slice(-8))})()`

let cdp
try {
  await sleep(1500)
  const target = await findPageTarget(PORT, { timeoutMs: 45000 })
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const ev = (expr, label) => evaluate(cdp, expr, { label, allowUndefined: true })

  const ready = await (async () => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (await ev(`!!document.querySelector('textarea')`, '等输入框')) return true
      await sleep(500)
    }
    return false
  })()
  rec('界面就绪（有输入框）', ready, ready ? 'textarea 出现' : '30 秒没等到')
  if (!ready) throw new Error('界面没起来')

  await ev(NEW_CHAT, '新建对话')
  await sleep(1200)
  const typed = await ev(fillExpr('说一句我能看懂的话'), '填输入框')
  rec('输入框可写', typed === '说一句我能看懂的话'.length, `写入 ${typed} 字`)
  await sleep(400)
  const sent = await ev(SEND, '点发送')
  rec('发送按钮可点', sent === true, sent ? '已点发送' : '没找到发送按钮')

  /* 等假上游收到第 2 次请求（= 内核真的重试了），最多 90 秒 */
  const deadline = Date.now() + 90000
  while (Date.now() < deadline && !/retry 第 2 次/.test(upstreamLog)) await sleep(700)
  rec(
    '★ 内核真的重试了（上游收到第 2 次请求）',
    /retry 第 2 次/.test(upstreamLog),
    /retry 第 1 次/.test(upstreamLog) ? '第 1 次截断 + 第 2 次完整' : '第 1 次都没收到',
  )

  /* 等这一轮收尾（正文上屏 + 状态不再是 streaming） */
  await sleep(4000)

  const fullCount = await ev(COUNT(FULL), '数完整那句')
  const partialOnly = await ev(HAS_PARTIAL_ONLY, '看那半截还在不在')

  rec('★ 完整正文在屏幕上（重试没吞内容）', Number(fullCount) >= 1, `出现 ${fullCount} 次`)
  rec('★★ 完整正文只出现 1 次（不显示两遍）', Number(fullCount) === 1, `出现 ${fullCount} 次`)
  rec('★★ 那半截没有残留在屏幕上', partialOnly === false, partialOnly ? '半截还在' : '已退回')

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(resolve(ROOT, 'shots', 'electron'), { recursive: true })
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
  console.log(`  截图 → ${SHOT}`)

  /* 图像证据之外再留一份文本证据：截图靠识图读，读不到时这里还能说话 */
  const domText = await ev(
    `(function(){
      const art=[...document.querySelectorAll('[data-message-id]')].pop()
      if(!art) return '(没有消息)'
      return (art.innerText||'').slice(0,1200)
    })()`,
    '读回那条消息的文本',
  )
  console.log('  ── 那条消息在屏幕上的真实文本 ──')
  console.log(String(domText))
  console.log('  ──────────────────────────────')
} catch (error) {
  console.error('E2E 失败：', error instanceof Error ? error.message : error)
  rec('E2E 跑通', false, String(error?.message ?? error))
  if (appLog.trim()) console.error(appLog.slice(-1500))
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
