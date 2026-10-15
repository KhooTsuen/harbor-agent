/**
 * M04 第 2 步真机验收：**点击**与**验证**（真下行通道）
 *
 * ── 链路全真 ─────────────────────────────────────────────────
 *
 *   验收进程里的 `ext-command`（真）--push--> 真命名管道 → 真 native host 子进程
 *     → 真 Edge + 真扩展（构建产物副本）→ 真 `chrome.scripting.executeScript`
 *     → 真页面 DOM → 真回执 → 回执配对 → 真落盘（真 session / 真 audit）
 *
 * ★ **这是下行通道第一次真机跑通**（M04-1 只做了上行）—— 所以本脚本最值钱的一条
 *   就是「指令真的穿过去了，而且真的点到页面上了」。
 *
 * ★ 为什么验收进程**自己起 bridge**（与 `accept-phase3a` 同一招）：这样能在
 *   **同一进程里**直接调 `extCommand.click()` 并观察结果，不必起 Electron。
 *   代价是：这次验的不是「主进程里那份 extCommand」，而是「同一份代码的另一实例」——
 *   取舍如实写在这里。
 *
 * 隔离：独立 profile / 隔离数据根（data/unit-test-data）/ 跑完删 profile + 还原数据。
 * ★ **不碰注册表**？—— 碰。扩展要经 native messaging 连 host，必须写注册表；
 *   所以这里**先快照、跑完恢复原值并回读比对**（3c 那次踩过的坑，别再犯）。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn, spawnSync } = require('node:child_process')

const D = require('../lib/driver.cjs')
const P = require('../lib/ext-probe.cjs')
const S = require('../lib/ext-stage.cjs')

const ROOT = S.ROOT
const ISO = path.join(ROOT, 'data', 'unit-test-data')
const CONF = path.join(ISO, 'config.json')
const CRED = path.join(ISO, 'credentials.json')
const HOST_NAME = 'com.harbor.agent'
const PORT_EDGE = 9343
const PORT_PAGE = 8831
const PROFILE = 'profile-m04b'
const DIST = path.join(ROOT, 'harbor-edge', 'dist', 'sidepanel')
const STAGE = path.join(ISO, 'm04b-ext')

/*
 * ── ★ 为什么要用「加了 host_permissions 的副本」──────────────────
 *
 * 产品 manifest **刻意没有** `host_permissions`（M07「不默认要全站权限」），
 * 而 CDP 驱动下 `activeTab` **不会**授予（accept-phase2 ⑧ 早记过）→ 真 `executeScript`
 * 注入会失败（`Cannot access contents of the page…`）。所以验收必须给**副本**
 * 临时加 `host_permissions: 127.0.0.1/*` —— **只在副本里，不改产品 manifest**。
 *
 * 口径与 `accept-m04a` 一致（同一件事两处都写清楚，免得下次又踩）。
 */
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

/* ── 隔离数据（不调模型：baseUrl 指到没人听的端口） ── */
const confBackup = fs.existsSync(CONF) ? fs.readFileSync(CONF, 'utf8') : null
const credBackup = fs.existsSync(CRED) ? fs.readFileSync(CRED, 'utf8') : null
const restoreData = () => {
  try {
    if (confBackup === null) fs.rmSync(CONF, { force: true })
    else fs.writeFileSync(CONF, confBackup)
    if (credBackup === null) fs.rmSync(CRED, { force: true })
    else fs.writeFileSync(CRED, credBackup)
  } catch {
    /* 忽略 */
  }
}
fs.mkdirSync(ISO, { recursive: true })
const baseCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'))
baseCfg.providers[0].baseUrl = 'http://127.0.0.1:9/v1'
if (baseCfg.general) baseCfg.general.defaultWorkdir = path.join(ISO, 'chat')
fs.writeFileSync(CONF, JSON.stringify(baseCfg, null, 2))
fs.writeFileSync(CRED, JSON.stringify({ version: 1, backend: 'plain', entries: { 'provider:deepseek': { key: 'sk-fake' } } }))

/* ── 注册表**真原值**共享快照（跑完恢复 + 回读比对 —— 3c 的教训）── */
const regSnap = S.snapshotRegistry(HOST_NAME)

/* ── 测试页：按钮改 DOM + 链接改 URL（两种「状态证据」各一条）── */
const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>M04 验收页</title></head><body>
<h1>M04 验收页</h1>
<div id="out">初始</div>
<button id="go" onclick="document.getElementById('out').textContent='已点击'; var d=document.createElement('div'); d.textContent='新节点'; document.body.appendChild(d);">点我</button>
<a id="link" href="/next">去下一页</a>
<input id="txt" placeholder="随便">
</body></html>`
const PAGE_NEXT = `<!doctype html><html><head><meta charset="utf-8"><title>M04 下一页</title></head><body><p>到了下一页</p></body></html>`

const servers = []
const serverErrors = []
function serve(port, html) {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(req.url && req.url.startsWith('/next') ? PAGE_NEXT : html)
  })
  s.on('error', (e) => serverErrors.push(`端口 ${port}：${(e && e.message) || e}`))
  s.listen(port, '127.0.0.1')
  servers.push(s)
  return s
}
serve(PORT_PAGE, PAGE)

/** 等端口真的在听（判据是「连得上」，不是「等了几毫秒」） */
async function waitPort(port, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  return false
}

let edge = null

async function main() {
  /* ── ①② 测试页 + 隔离 host 就位 ── */
  const pageOk = (await waitPort(PORT_PAGE)) && serverErrors.length === 0
  rec('① 测试页服务起来了', pageOk, serverErrors.length ? serverErrors.join(' | ') : `:${PORT_PAGE}`)
  if (!pageOk) return false

  /*
   * ── 在**本进程**起桥（真管道）──
   * 扩展的 host 是 Edge 拉起的**子进程**，它连的管道名由 dataDir 决定 ——
   * 所以只要 dataDir 一致就连得上（与 accept-phase3a 同一做法）。
   */
  process.env.HARBOR_UNIT_TEST = '1'
  const B = require(path.join(ROOT, 'electron/core/ext-bridge.cjs'))
  const EC = require(path.join(ROOT, 'electron/core/ext-command.cjs'))
  const P_ = require(path.join(ROOT, 'electron/core/ext-protocol.cjs'))
  const session = require(path.join(ROOT, 'electron/core/session.cjs'))
  const audit = require(path.join(ROOT, 'electron/core/audit.cjs'))
  const { wrapWebText } = require(path.join(ROOT, 'electron/core/tools/_web-note.cjs'))

  const pushed = []
  const bridge = B.createBridge()
  const command = EC.createCommand({
    getBridge: () => bridge,
    log: { info: (m) => console.log('   [指令]', m), warn: (m) => console.log('   [指令!]', m) },
    land: (kind, result, meta) => bridge.landAction(kind, result, meta),
  })
  const started = bridge.start({
    dataDir: ISO,
    send: (n, p) => pushed.push({ n, p }),
    session,
    audit,
    wrap: wrapWebText,
    log: { info: (m) => console.log('   [桥]', m), warn: (m) => console.log('   [桥!]', m) },
    command,
  })
  rec('② 验收进程里的桥起来了（真管道）', started.ok === true, started.name)
  if (!started.ok) return false

  /* ── ③ 起 Edge + 装隔离 host（顺序：**先摘注册表**再起 Edge，免 SW 连上旧 host）── */
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

  /* 测试页要**先**开（它得是前台活动标签 —— 扩展只动前台当前标签） */
  const pageTab = await D.openTab(PORT_EDGE, `http://127.0.0.1:${PORT_PAGE}/`)
  await sleep(1200)
  const panel = await D.openTab(PORT_EDGE, `chrome-extension://${extId}/index.html`)
  await sleep(800)

  /**
   * 把某个标签**带到前台**（CDP 的 HTTP 端点）。
   *
   * ★ 为什么需要它：扩展只动**前台当前标签**，而 `openTab` 每开一个就把前一个挤到后台 ——
   *   所以「先开测试页、后开侧边栏」的结果是**侧边栏在前台**，扩展于是报「该页面不支持读取」
   *   （chrome-extension:// 命中受限协议）。M04-1 的验收也踩过这个坑。
   * ★ 用 activate 而**不是**再 open 一次：重开会多一个标签、还得重新等加载。
   */
  const activate = (targetId) =>
    fetch(`http://127.0.0.1:${PORT_EDGE}/json/activate/${targetId}`)
      .then((r) => r.ok)
      .catch(() => false)
  await activate(pageTab.target.id)
  await sleep(700)

  const stagedHost = S.stageHost({ dataDir: ISO, extId, name: HOST_NAME, tag: 'm04b' })
  rec('⑤ 装好隔离 host', fs.existsSync(stagedHost.exe), stagedHost.cmd)

  /* 等侧边栏连上（= SW 连上 host = 我的桥有连接了） */
  const conn = await D.pollEval(
    panel,
    `(function(){ const h = document.querySelector('header'); return h ? h.innerText : '' })()`,
    (v) => typeof v === 'string' && v.includes('已连接'),
    { tries: 40 },
  )
  rec('⑥ 侧边栏连上了（SW → host → 我的桥）', conn.ok === true, String(conn.value).split('\n')[0])
  if (!conn.ok) return false

  /*
   * ★★ ⑥b：等**管道上真的有连接** —— 这一条是 M04 踩出来的。
   *
   * 「侧边栏显示已连接」只说明 **SW ↔ host** 通了；主进程要能**推指令**，还需要
   * **host ↔ 主进程** 那条管道连着。原来 `ext-client` 是**懒连**（第一次请求才连），
   * 于是「扩展刚连上、还没发过任何请求」时主进程推啥都掉地上（真机：`sent: 0`）。
   * 修法是 host 启动就主动连（见 `ext-client.ensureConnected`）。
   * 这里等到连接数 ≥ 1 再往下 —— 否则后面所有判据都会以「NO_BROWSER」假红。
   */
  let conns = 0
  for (let i = 0; i < 30 && conns < 1; i += 1) {
    conns = bridge.connectionCount()
    if (conns < 1) await sleep(300)
  }
  rec('⑥b ★★ 管道上真有连接了（主进程能主动推指令的前提）', conns >= 1, `连接数=${conns}`)
  if (conns < 1) return false

  /* 点回测试页，确保它是**前台活动标签**（扩展只动它） */
  await D.pollEval(pageTab, 'document.title', (v) => String(v).includes('M04'), { tries: 10 })
  await activate(pageTab.target.id)
  await sleep(500)

  const sessionsBefore = fs.readdirSync(path.join(ISO, 'sessions')).filter((f) => f.endsWith('.jsonl')).length

  /* ══ 判据 1：真下行通道拿回元素引用 ══ */
  const els = await command.getElements({})
  rec(
    '⑦ ★★ 走**真下行通道**拿回元素列表（扩展真注入）',
    els && els.ok === true,
    els && els.ok === true ? `${els.url} · 版本 ${els.pageVersion} · ${(els.elements ?? []).length} 个` : `error=${JSON.stringify((els && els.error) || els)}`,
  )
  if (!els || els.ok !== true) return false
  const list = els.elements ?? []
  rec('⑦ 列表里有按钮和链接', list.some((e) => /点我/.test(String(e.text))) && list.some((e) => /去下一页/.test(String(e.text))), list.map((e) => `${e.role}:${String(e.text).slice(0, 6)}`).join(' | '))
  const btnRef = (list.find((e) => /点我/.test(String(e.text))) ?? {}).ref ?? ''
  const linkRef = (list.find((e) => /去下一页/.test(String(e.text))) ?? {}).ref ?? ''
  rec('⑦ 每个引用都带当前版本号前缀', Boolean(btnRef) && btnRef.startsWith(els.pageVersion), `${btnRef} vs ${els.pageVersion}`)

  /* ══ 判据 2：点击 —— 真点到页面上 + 带状态证据 ══ */
  const c1 = await command.click({ ref: btnRef, settleMs: 600 })
  rec('⑧ ★★ 点击指令穿过真下行通道并执行', c1 && c1.ok === true, JSON.stringify(c1 && c1.error ? c1.error.message : 'ok'))
  const ev = (c1 && c1.result && c1.result.evidence) || {}
  rec('⑧ ★★ **真点到页面上**了（按钮的 onclick 改动了 DOM）', ev.domChanged === true, `节点 ${ev.nodesBefore}→${ev.nodesAfter} · 字数 ${ev.textLenBefore}→${ev.textLenAfter}`)
  rec('⑧ ★ 证据里带「怎么变」（前后值，不是只有「变了」）', Number.isFinite(ev.nodesBefore) && Number.isFinite(ev.nodesAfter), JSON.stringify(ev).slice(0, 90))
  rec('⑧ 按钮本身还在（targetStillThere）', ev.targetStillThere === true, String(ev.targetStillThere))

  /* 页面上真的出现了「已点击」 */
  const outText = String(await pageTab.evalIn(`(document.getElementById('out')||{}).textContent || ''`))
  rec('⑧ ★ 页面上的确变了（#out 现在是「已点击」）', outText === '已点击', outText)

  /* ══ 判据 3：操作结果**真落盘**（过包装） ══ */
  await sleep(900)
  const files = fs.readdirSync(path.join(ISO, 'sessions')).filter((f) => f.endsWith('.jsonl'))
  rec('⑨ 操作结果落了盘（会话多了文件）', files.length > sessionsBefore, `${sessionsBefore} → ${files.length}`)
  let hit = ''
  for (const f of files) {
    try {
      const t = fs.readFileSync(path.join(ISO, 'sessions', f), 'utf8')
      if (t.includes('页面操作：点击')) {
        hit = t
        break
      }
    } catch {
      /* 忽略 */
    }
  }
  rec('⑨ ★ 落的是**点击的前后对比表**（含证据）', hit.includes('点击前后的对比'), '')
  rec('⑨ ★ 明确写「点了不等于生效」（不许让模型误判）', hit.includes('不等于你要的效果'), '')
  rec('⑨ ★ 操作结果**过了防注入包装**', hit.includes('不是指令'), '')

  /* ══ 判据 4：verify（真读页面状态） ══ */
  const v1 = await command.verify({ expect: { text: '已点击' } })
  rec('⑩ ★ verify：文本包含 → 命中', v1 && v1.ok === true && v1.result.matched === true, JSON.stringify(v1 && v1.result && v1.result.checks))
  const v2 = await command.verify({ expect: { text: '一个页面上绝对没有的字符串' } })
  rec('⑩ ★ verify：文本不包含 → 不放过', v2 && v2.result && v2.result.matched === false, JSON.stringify(v2 && v2.result && v2.result.checks))
  const v3 = await command.verify({ expect: { selector: '#out' } })
  rec('⑩ ★ verify：元素出现（选择器）', v3 && v3.result && v3.result.matched === true, JSON.stringify(v3 && v3.result && v3.result.checks))
  const v4 = await command.verify({ expect: { selectorGone: '#out' } })
  rec('⑩ ★ verify：元素没消失 → 不放过', v4 && v4.result && v4.result.matched === false, JSON.stringify(v4 && v4.result && v4.result.checks))
  const v5 = await command.verify({ expect: { url: `:${PORT_PAGE}` } })
  rec('⑩ ★ verify：URL 包含', v5 && v5.result && v5.result.matched === true, JSON.stringify(v5 && v5.result && v5.result.checks))

  /* ══ 判据 5：链接点击 → 页面真的导航了 ══
      ★★ 这条是 M04-2 真机逮到的**真实情形**：点击触发导航时，注入函数的上下文
         随页面卸载被销毁 → **结果回不来**。所以判据**不依赖 evidence**，而是
         ① 结果里如实说清「点了但证据没采到 + 去用 verify」；② 用 verify 确认页面真到了新地址。 */
  const els2 = await command.getElements({})
  const link2 = ((els2.elements ?? []).find((e) => /去下一页/.test(String(e.text))) ?? {}).ref ?? ''
  rec('⑪ 重新观察后拿到链接引用', Boolean(link2), `${linkRef} → ${link2}`)
  const c2 = await command.click({ ref: link2, settleMs: 900 })
  console.log('  [诊断] 导航型点击的完整返回 =', JSON.stringify(c2).slice(0, 400))
  /* ★ 形状统一：浏览器回来的东西一律在 `result` 里（成功与「没采到证据」同一处取） */
  const noRes = Boolean(c2 && c2.result && c2.result.reason === 'no-result')
  rec(
    '⑪ ★★ 导航型点击：结果回不来时**如实说清**（不假装成功、不笼统报错）',
    noRes || (c2 && c2.result && c2.result.evidence && c2.result.evidence.urlChanged === true),
    noRes ? String(c2.result.message).slice(0, 60) : JSON.stringify(c2 && c2.result && c2.result.evidence),
  )
  const urlAfter = String(await pageTab.evalIn(`location.href`))
  rec('⑪ ★★ 页面**真的导航了**（点链接生效 —— 用页面本身确认，不信回执）', /\/next/.test(urlAfter), urlAfter)
  const v6 = await command.verify({ expect: { text: '到了下一页', url: '/next' } })
  rec('⑪ ★ verify 确认到了新页面的状态（两条期望都命中）', v6 && v6.result && v6.result.matched === true, JSON.stringify(v6 && v6.result && v6.result.checks))

  /* ══ 判据 6：引用失效保护（**点之前**就拦，指令根本不发） ══ */
  const stale = await command.click({ ref: btnRef, settleMs: 300 })
  rec('⑫ ★★ 旧引用 → STALE_REF（**根本没点**）', stale && stale.ok === false && stale.error.code === P_.ERR.STALE_REF, JSON.stringify(stale && stale.error))
  rec('⑫ ★ 回绝时带上「引用哪版 / 当前哪版」', stale.refVersion !== stale.pageVersion, `${stale.refVersion} vs ${stale.pageVersion}`)
  rec('⑫ ★ 人话要求「重新观察」', /重新观察/.test(String(stale.error.message)), String(stale.error.message))
  const urlNow = String(await pageTab.evalIn(`location.href`))
  rec('⑫ ★ 页面**没有**因为那次回绝而被改动（还在下一页）', /next/.test(urlNow), urlNow)

  const els3 = await command.getElements({})
  const notFound = await command.click({ ref: `${els3.pageVersion}.999`, settleMs: 300 })
  rec('⑫ 同版本但不存在的 ref → 也拒绝（not-found）', notFound && notFound.ok === false && notFound.error.code === P_.ERR.STALE_REF, JSON.stringify(notFound && notFound.error))

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
    for (const s of servers) {
      try {
        s.close()
      } catch {
        /* 忽略 */
      }
    }
    try {
      if (edge) D.killEdge(edge.child.pid)
    } catch {
      /* 忽略 */
    }
    await sleep(800)
    /* 注册表：恢复**真原值** + 回读比对（3c 那次「无条件说恢复了」的教训） */
    const rr = S.restoreRegistry(HOST_NAME, regSnap.value)
    console.log(`清理：注册表实际值 = ${rr.actual || '(键不存在)'}`)
    console.log(`      真原值       = ${rr.want || '(无)'} → ${rr.ok ? '✓ 一致' : '✗ 不一致（手工 reg ADD 回原值）'}`)
    if (regSnap.polluted) console.log('      ⚠ 备份里也是隔离值 —— 原值可能早已被覆盖，请人工确认')
    if (!rr.ok || regSnap.polluted) ok = false
    try {
      D.removeProfile(path.join(ROOT, 'harbor-edge', 'profiles', PROFILE))
    } catch {
      /* 忽略 */
    }
    try {
      S.unstageHost({ dataDir: ISO, tag: 'm04b' })
    } catch {
      /* 忽略 */
    }
    try {
      fs.rmSync(STAGE, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    restoreData()
    console.log('清理：profile 已删 / 隔离 host 已卸 / 副本已删 / 隔离数据已还原')
    process.exit(ok ? 0 : 1)
  }
})()
