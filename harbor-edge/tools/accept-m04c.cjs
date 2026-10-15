/**
 * M04-3 真机验收：**不打开侧边栏**，主进程主动推指令，扩展收到并执行。
 *
 * ── 为什么要单独验 ───────────────────────────────────────────
 *
 * 上一版 `ext-client` 是**懒连**（扩展第一次发请求才连管道），于是「扩展没主动发过
 * 请求时，主进程想推指令推不出去」—— 3b 的流式能用只是巧合（用户先发过 chat:send）。
 * 修法是 host 启动就主动连（`ext-client.ensureConnected`，见 ext-host-loop.cjs）。
 *
 * 本脚本验的就是这条**反向链路**：
 *   主进程 `command.getElements()` --push--> 命名管道 → host → native port → SW
 *     → 注入前台测试页 → 回执 → 主进程按 id 配对。
 * 全程**不打开侧边栏**（SW 靠 Edge 启动时的 connect + scheduleReconnect 自动连 host）。
 *
 * 隔离：独立 profile / 隔离数据根 / 副本加 host_permissions（产品 manifest 不加）/ 注册表快照恢复。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawnSync } = require('node:child_process')

const D = require('../lib/driver.cjs')
const P = require('../lib/ext-probe.cjs')
const S = require('../lib/ext-stage.cjs')

const ROOT = S.ROOT
const ISO = path.join(ROOT, 'data', 'unit-test-data')
const CONF = path.join(ISO, 'config.json')
const CRED = path.join(ISO, 'credentials.json')
const HOST_NAME = 'com.harbor.agent'
const PORT_EDGE = 9344
const PORT_PAGE = 8832
const PROFILE = 'profile-m04c'
const DIST = path.join(ROOT, 'harbor-edge', 'dist', 'sidepanel')
const STAGE = path.join(ISO, 'm04c-ext')

/* 副本加 host_permissions（与 m04a/m04b 同一口径；产品 manifest 不加，M07） */
fs.rmSync(STAGE, { recursive: true, force: true })
fs.cpSync(DIST, STAGE, { recursive: true })
const mf = path.join(STAGE, 'manifest.json')
const mfJson = JSON.parse(fs.readFileSync(mf, 'utf8'))
mfJson.host_permissions = ['http://127.0.0.1/*']
fs.writeFileSync(mf, JSON.stringify(mfJson, null, 2))

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  -- ${detail}`)
}
const sleep = P.sleep

/* 隔离数据（不调模型） */
const confBackup = fs.existsSync(CONF) ? fs.readFileSync(CONF, 'utf8') : null
const credBackup = fs.existsSync(CRED) ? fs.readFileSync(CRED, 'utf8') : null
const restoreData = () => {
  try {
    if (confBackup === null) fs.rmSync(CONF, { force: true })
    else fs.writeFileSync(CONF, confBackup)
    if (credBackup === null) fs.rmSync(CRED, { force: true })
    else fs.writeFileSync(CRED, credBackup)
  } catch { /* 忽略 */ }
}
fs.mkdirSync(ISO, { recursive: true })
const baseCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'))
baseCfg.providers[0].baseUrl = 'http://127.0.0.1:9/v1'
if (baseCfg.general) baseCfg.general.defaultWorkdir = path.join(ISO, 'chat')
fs.writeFileSync(CONF, JSON.stringify(baseCfg, null, 2))
fs.writeFileSync(CRED, JSON.stringify({ version: 1, backend: 'plain', entries: { 'provider:deepseek': { key: 'sk-fake' } } }))

const regSnap = S.snapshotRegistry(HOST_NAME)

/* 测试页：几个可交互元素（只要能被采集到即可） */
const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>M04C 验收页</title></head><body>
<h1>M04C 验收页</h1>
<button id="a">按钮甲</button>
<a id="b" href="/next">链接乙</a>
<input id="c" placeholder="输入丙">
</body></html>`

const servers = []
const serverErrors = []
function serve(port, html) {
  const s = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  s.on('error', (e) => serverErrors.push(`端口 ${port}：${(e && e.message) || e}`))
  s.listen(port, '127.0.0.1')
  servers.push(s)
  return s
}
serve(PORT_PAGE, PAGE)

async function waitPort(port, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await sleep(200)
  }
  return false
}

let edge = null

async function main() {
  const pageOk = (await waitPort(PORT_PAGE)) && serverErrors.length === 0
  rec('① 测试页服务起来了', pageOk, serverErrors.length ? serverErrors.join(' | ') : `:${PORT_PAGE}`)
  if (!pageOk) return false

  /* 本进程起桥 + 下行指令（与 m04b 同一招） */
  process.env.HARBOR_UNIT_TEST = '1'
  const B = require(path.join(ROOT, 'electron/core/ext-bridge.cjs'))
  const EC = require(path.join(ROOT, 'electron/core/ext-command.cjs'))
  const session = require(path.join(ROOT, 'electron/core/session.cjs'))
  const audit = require(path.join(ROOT, 'electron/core/audit.cjs'))
  const { wrapWebText } = require(path.join(ROOT, 'electron/core/tools/_web-note.cjs'))

  const bridge = B.createBridge()
  const command = EC.createCommand({
    getBridge: () => bridge,
    log: { info: () => {}, warn: (m) => console.log('   [指令!]', m) },
    land: (kind, result, meta) => bridge.landAction(kind, result, meta),
  })
  const started = bridge.start({
    dataDir: ISO,
    send: () => {},
    session,
    audit,
    wrap: wrapWebText,
    log: { info: () => {}, warn: () => {} },
    command,
  })
  rec('② 验收进程里的桥起来了（真管道）', started.ok === true, started.name)
  if (!started.ok) return false

  /* 摘注册表 → 起 Edge（SW 首连失败，3 秒后 scheduleReconnect）→ 装隔离 host */
  S.regDel(HOST_NAME)
  edge = await D.launchEdge({ profileName: PROFILE, port: PORT_EDGE, extDir: STAGE, waitMs: 2500 })
  rec('③ Edge 起来了（隔离 profile）', edge.ready === true, `pid=${edge.child.pid}`)

  let extId = null
  for (let i = 0; i < 40 && !extId; i += 1) {
    await sleep(500)
    extId = D.readExtIdFromProfile(edge.profile, STAGE)
  }
  rec('④ 真扩展被加载（副本，带 host_permissions）', Boolean(extId), String(extId))
  if (!extId) return false

  /* 打开**测试页**（前台）—— 全程**不打开侧边栏** */
  const pageTab = await D.openTab(PORT_EDGE, `http://127.0.0.1:${PORT_PAGE}/`)
  await sleep(1200)
  /*
   * ★ 显式把测试页带到前台（2026-10-16 加）。
   *   为什么需要：`SW` 只动**前台当前标签**，而 CDP 附着到任何 target **都会把它激活** ——
   *   串行跑多条脚本时，前一条留下的标签会把测试页挤到后台，于是这里报
   *   「读不到当前页地址」（看起来像坏，其实是前台跑偏）。
   *   单独跑不会现形 —— 所以这条修的正是「只有串行才红」的那种不稳。
   */
  try {
    await fetch(`http://127.0.0.1:${PORT_EDGE}/json/activate/${pageTab.target.id}`)
  } catch {
    /* 老版本没有这个端点：退化成「不切」，判据一旦红能看出来 */
  }
  await sleep(400)

  const stagedHost = S.stageHost({ dataDir: ISO, extId, name: HOST_NAME, tag: 'm04c' })
  rec('⑤ 装好隔离 host', fs.existsSync(stagedHost.exe), stagedHost.cmd)

  /*
   * ★★ 关键判据：**不打开侧边栏**，等 host 主动连上主进程管道。
   * 上一版懒连时这里永远连不上（主进程 push 拿到 sent:0）；修好后 host 启动即连。
   * SW 靠 Edge 启动时的 connect + scheduleReconnect 自动连 host（无需侧边栏唤醒）。
   */
  let conns = 0
  for (let i = 0; i < 40 && conns < 1; i += 1) {
    conns = bridge.connectionCount()
    if (conns < 1) await sleep(500)
  }
  rec('⑥ ★★ 不打开侧边栏，host 也主动连上了主进程（懒连缺口已修）', conns >= 1, `连接数=${conns}`)
  if (conns < 1) return false

  /* 主进程直接推指令（get-elements）—— 扩展要收到并执行 */
  const t0 = Date.now()
  const els = await command.getElements({})
  const ms = Date.now() - t0
  rec(
    '⑦ ★★ 主进程推指令，扩展收到并执行（不打开侧边栏）',
    els && els.ok === true && (els.elements ?? []).length >= 3,
    els && els.ok === true ? `${(els.elements ?? []).length} 个元素 · ${ms}ms` : `error=${JSON.stringify((els && els.error) || els)}`,
  )
  if (!els || els.ok !== true) return false
  const list = els.elements ?? []
  rec('⑦ 元素里能认出测试页的三个元素', list.some((e) => /按钮甲/.test(String(e.text))) && list.some((e) => /链接乙/.test(String(e.text))), list.map((e) => String(e.text).slice(0, 4)).join(' | '))

  const pass = results.filter((r) => r.pass).length
  console.log(`\n==== ${pass}/${results.length} 通过 ====`)
  if (pass !== results.length) {
    console.log('失败：')
    for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name}`)
  }
  return pass === results.length
}

void (async () => {
  let ok = false
  try {
    ok = await main()
  } catch (error) {
    console.log('验收脚本异常：', error && error.stack ? error.stack : String(error))
  } finally {
    for (const s of servers) { try { s.close() } catch { /* 忽略 */ } }
    try { if (edge) D.killEdge(edge.child.pid) } catch { /* 忽略 */ }
    await sleep(800)
    const rr = S.restoreRegistry(HOST_NAME, regSnap.value)
    console.log(`清理：注册表实际值 = ${rr.actual || '(键不存在)'}`)
    console.log(`      真原值       = ${rr.want || '(无)'} → ${rr.ok ? '✓ 一致' : '✗ 不一致'}`)
    if (!rr.ok || regSnap.polluted) ok = false
    try { D.removeProfile(path.join(ROOT, 'harbor-edge', 'profiles', PROFILE)) } catch { /* 忽略 */ }
    try { S.unstageHost({ dataDir: ISO, tag: 'm04c' }) } catch { /* 忽略 */ }
    try { fs.rmSync(STAGE, { recursive: true, force: true }) } catch { /* 忽略 */ }
    restoreData()
    console.log('清理：profile 已删 / 隔离 host 已卸 / 副本已删 / 隔离数据已还原')
    process.exit(ok ? 0 : 1)
  }
})()
