/**
 * M03 真机验收：网页感知（选区 / 可交互元素 / iframe 能力检测 / 页面版本号）
 *
 * 链路全真，分三段验（**每段验的是不同的一段真东西**）：
 *
 *   A 段 —— **采集器在真 DOM 上跑**：起本地 http server（两个端口 = 同源 + 跨域），
 *           真 Edge 打开测试页，通过 CDP 在那个页面上**真执行 `collectPageContext`**。
 *           判据：选区 / 元素列表 / 密码遮蔽 / 跨域如实报告 / 版本号稳定与变化 / 预算。
 *   B 段 —— **侧边栏按钮接线**：真扩展 + 侧边栏，点「观察页面」，状态行要出人话。
 *   C 段 —— **完整链路落盘**：真源码树 Harbor + 真 host（`runHost` 喂协议帧）→
 *           验会话文件里出现**渲染后的 markdown**、元素引用、且过了防注入包装。
 *
 * 隔离：独立 profile / 隔离数据根（data/unit-test-data）/ 跑完删 profile + 还原数据。
 * ★ **全程不碰注册表**（`runHost` 用 exe 直起 host，不走 Edge 的 native messaging）。
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
const PORT_EDGE = 9342
const PORT_APP = 9383
const PORT_VITE = 5277
const PORT_A = 8801
const PORT_B = 8802
const PROFILE = 'profile-m03'
const DIST = path.join(ROOT, 'harbor-edge', 'dist', 'sidepanel')
const OBSERVE_JS = path.join(ROOT, 'harbor-edge', 'extension', 'lib', 'observe.js')
const HARBOR_EXE = path.join(ROOT, 'dist-portable', 'Harbor', 'Harbor.exe')

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  -- ${detail}`)
}
const sleep = P.sleep

/* ── 隔离数据（M03 不调模型：baseUrl 指到一个没人听的端口，凭证给假的）── */
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
baseCfg.providers[0].baseUrl = `http://127.0.0.1:${PORT_B}/v1`
if (baseCfg.general) baseCfg.general.defaultWorkdir = path.join(ISO, 'chat')
fs.writeFileSync(CONF, JSON.stringify(baseCfg, null, 2))
fs.writeFileSync(CRED, JSON.stringify({ version: 1, backend: 'plain', entries: { 'provider:deepseek': { key: 'sk-fake' } } }))

/* ── 测试页（含：选区目标 / 按钮 / 禁用按钮 / 文本框 / **密码框** / 链接 / 勾选框 / 同源 + 跨域 iframe）── */
const PAGE_A = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>M03 验收页</title></head><body>
<h1>M03 验收页</h1>
<p id="pickme">这是用来做选区的一段文字。</p>
<button id="ok">提交</button>
<button id="dis" disabled>不可用按钮</button>
<input id="txt" placeholder="请输入名字">
<input id="pwd" type="password" value="secret123" placeholder="密码">
<a href="/next">下一步</a>
<input type="checkbox" id="cb" checked>
<iframe src="/inner" title="same"></iframe>
<iframe src="http://127.0.0.1:${PORT_B}/inner" title="cross"></iframe>
</body></html>`
const PAGE_B = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>另一个源</title></head><body><p>inner</p></body></html>`

const servers = []
/**
 * ★ 服务端错误**必须记下来**（2026-10-16 补）。
 *
 * 原来这里的 `listen` **没有 error 处理** —— 端口被占时它静默失败，
 * 但脚本照跑：A 段拿到的是**别人**的页面（或根本连不上），于是十几条判据
 * 一起来红，看着像「产品坏了」。实测踩到过：几条脚本串着跑时 m03 红 14 条，
 * **单独跑 31/31 全通**。
 *
 * 所以两件事都要做：① 错误记下来；② 开跑前**探一次端口**（见 waitPort），
 * 不在听就早退 —— 不在一堆假数据上得出假结论。
 */
const serverErrors = []
function serve(port, html) {
  const s = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  s.on('error', (error) => {
    const msg = `端口 ${port} 起不来：${(error && error.message) || error}`
    serverErrors.push(msg)
    console.error(`  ✗ 测试页服务失败 —— ${msg}`)
  })
  s.listen(port, '127.0.0.1')
  servers.push(s)
  return s
}
serve(PORT_A, PAGE_A)
serve(PORT_B, PAGE_B)

/**
 * 等端口**真的在听**。
 *
 * ★ 判据是「连得上」，不是「等了几毫秒」—— 这是 `harbor-edge/README.md`
 *   那条硬规则（不许拿固定毫秒当判据）。上限 4 秒，超了算失败。
 */
async function waitPort(port, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    try {
      /* 带超时：万一端口上蹲着一个「连得上但不响应」的东西，别在这儿挂死 */
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return true
    } catch {
      /* 还没起来 / 超时 */
    }
    await sleep(200)
  }
  return false
}

/* ── 源码树 Harbor（隔离数据根）+ vite ── */
const procs = []
const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT_VITE), '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
})
procs.push(vite)
vite.stdout.on('data', () => {})
vite.stderr.on('data', () => {})

const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${PORT_APP}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VITE_DEV_SERVER_URL: `http://localhost:${PORT_VITE}`, HARBOR_UNIT_TEST: '1' },
})
procs.push(app)
const killTree = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })

let edge = null

/** 把采集器源码抠成「不带 export 的函数定义」（在页面里内联执行它） */
function collectorSource() {
  return fs.readFileSync(OBSERVE_JS, 'utf8').replace(/^export\s+/gm, '')
}
/** 在页面里跑一次采集器，返回它的结果对象 */
function runCollectorExpr(opts = '{}') {
  return `(function(){ ${collectorSource()} ; return JSON.stringify(collectPageContext(${opts})); })()`
}
/** 让测试页里某个元素被选中 */
const SELECT_TEXT = `(function(){
  const el = document.querySelector('#pickme');
  if (!el) return 'no-el';
  const r = document.createRange(); r.selectNodeContents(el);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  return String(s.toString());
})()`
/** 改一下 DOM（加一个按钮）—— 用来验「版本号会变」 */
const MUTATE = `(function(){ const b = document.createElement('button'); b.textContent = '新加的按钮'; document.body.appendChild(b); return true; })()`
/** 侧边栏状态行（人话） */
const STATUS = P.STATUS_TEXT_EXPR
const CLICK_OBSERVE = P.CLICK_OBSERVE_EXPR
const PANEL_READY = `[...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === '观察页面')`

/** 等源码树主进程就绪（它要跑 vite + Electron，冷启动几秒 —— 不等就喂帧会得到空回复） */
async function waitApp(tries = 90) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT_APP}/json/version`)
      if (r.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  return false
}

async function main() {
  const P2 = path.join(ISO, 'sessions')
  const before = fs.existsSync(P2) ? fs.readdirSync(P2).filter((f) => f.endsWith('.jsonl')).length : 0

  /*
   * ── ★ 开跑前先确认两个测试页端口**真的在听** ──
   * 不在听就别往下跑：A 段所有判据都会在一片假数据上得出「产品坏了」的假结论
   * （实测：端口冲突时它红 14 条，而单独跑 31/31 全通）。所以这里**早退**。
   */
  const portA = await waitPort(PORT_A)
  const portB = await waitPort(PORT_B)
  const portsOk = portA === true && portB === true && serverErrors.length === 0
  rec(
    '⓪b ★ 两个测试页端口都在听（不在听 = 后面判据全无意义）',
    portsOk,
    serverErrors.length ? serverErrors.join(' | ') : `A=${portA} · B=${portB}`,
  )
  if (!portsOk) return false

  /* ── 先等主进程（C 段要用它；没起来时喂帧只会得到空回复）── */
  const appReady = await waitApp()
  rec('⓪ 源码树主进程就绪（C 段喂帧的前提）', appReady === true, appReady ? 'CDP 端口通' : '90 次没等到')

  /* ── 起 Edge + 扩展 ── */
  edge = await D.launchEdge({ profileName: PROFILE, port: PORT_EDGE, extDir: DIST, waitMs: 2500 })
  rec('① Edge 起来了（隔离 profile）', edge.ready === true, `pid=${edge.child.pid}`)
  let extId = null
  for (let i = 0; i < 40 && !extId; i += 1) {
    await sleep(500)
    extId = D.readExtIdFromProfile(edge.profile, DIST)
  }
  rec('② 真扩展被加载', Boolean(extId), String(extId))

  /* ══ A 段：采集器在真 DOM 上跑（M03 的核心）══ */
  const page = await D.openTab(PORT_EDGE, `http://127.0.0.1:${PORT_A}/`)
  /*
   * ★ 等**标题真的对**，不是等固定毫秒（2026-10-16 串行跑时踩到）。
   *   原来是 `sleep(1200)` —— 机器忙（几条脚本连着跑、Edge 冷启动）时页面还没加载完，
   *   `document.title` 是空的 → ③ 红，接着 A 段 8 条判据**全红**（一片「产品坏了」的假象，
   *   而单独跑 32/32 全通）。判据必须是「目标状态出现了」—— 与 README 那条硬规则同源。
   */
  const titlePoll = await D.pollEval(page, `document.title`, (v) => String(v) === 'M03 验收页', { tries: 40 })
  await sleep(300)
  const title = String(await page.evalIn(`document.title`))
  rec('③ 测试页打开了（真页面，不是桩）', title === 'M03 验收页', title)

  /* 先设一个选区，再采集 */
  const sel = String(await page.evalIn(SELECT_TEXT))
  rec('③ 选区已设置', sel.includes('选区的一段文字'), sel.slice(0, 30))

  const raw1 = await page.evalIn(runCollectorExpr('{maxItems:60,maxSelection:4000}'))
  const o1 = P.safeJson(raw1) ?? {}
  rec('④ ★ 采集器在真页面上跑通了（返回结构）', typeof o1 === 'object' && Boolean(o1.pageVersion), `version=${o1.pageVersion}`)

  /* ④-1 选区 */
  const selection = o1.selection ?? null
  rec(
    '④ ★ 选区文本 + 所在元素引用都拿到了',
    Boolean(selection && String(selection.text).includes('选区的一段文字') && /^[0-9a-f]+\./.test(String(selection.ref))),
    `text=${String(selection?.text ?? '').slice(0, 20)} ref=${selection?.ref}`,
  )

  /* ④-2 元素列表 */
  const els = Array.isArray(o1.elements) ? o1.elements : []
  const byText = (t) => els.find((e) => String(e.text).includes(t))
  rec('④ ★ 列出的元素 ≥ 5 个（真页面上确实这么多）', els.length >= 5, `条数=${els.length}`)
  rec(
    '④ ★ 按钮认成 button、文本对得上',
    Boolean(byText('提交')) && byText('提交').role === 'button',
    JSON.stringify(byText('提交') ?? {}).slice(0, 90),
  )
  rec('④ 禁用状态读出来了（disabled=true）', Boolean(byText('不可用按钮')) && byText('不可用按钮').disabled === true)
  rec('④ 勾选框状态读出来了（checked=true）', Boolean(els.find((e) => e.role === 'checkbox' && e.checked === true)))
  rec('④ 文本框认成 textbox', Boolean(byText('请输入名字')) && byText('请输入名字').role === 'textbox')

  /* ④-3 ★ 敏感字段（M07 的安全要求，M03 就得做到） */
  const pwd = els.find((e) => e.tag === 'INPUT' && e.masked === true)
  rec('④ ★ 密码框被标 masked', Boolean(pwd), JSON.stringify(pwd ?? {}).slice(0, 80))
  rec(
    '④ ★★ 密码框的 value **一个字都没带出来**（不是脱敏，是不给）',
    Boolean(pwd) && pwd.value === null && !JSON.stringify(o1).includes('secret123'),
  )

  /* ④-4 iframe 能力检测 */
  const frames = Array.isArray(o1.frames) ? o1.frames : []
  const cross = frames.find((f) => String(f.src).includes(String(PORT_B)))
  const same = frames.find((f) => String(f.src).includes('/inner') && !String(f.src).includes(String(PORT_B)))
  rec('④ ★ 跨域 iframe：如实报「读不到」+ 原因', Boolean(cross) && cross.accessible === false && /跨域/.test(String(cross.reason)), JSON.stringify(cross ?? {}).slice(0, 100))
  rec('④ ★ 同源 iframe：如实报「可读」', Boolean(same) && same.accessible === true, JSON.stringify(same ?? {}).slice(0, 100))
  rec(
    '④ ★ 跨域 iframe **没有**任何内容字段（不捏造）',
    Boolean(cross) && cross.content === undefined && cross.text === undefined,
  )
  rec('④ shadow 检测有结论（不猜数量）', typeof o1?.shadow?.open === 'number' && Boolean(o1?.shadow?.note), `open=${o1?.shadow?.open}`)

  /* ④-5 版本号：同页面两次必须**相同**（否则「没变」判断不出来） */
  const raw2 = await page.evalIn(runCollectorExpr('{}'))
  const o2 = P.safeJson(raw2) ?? {}
  rec('⑤ ★ 同一页面反复观察 → 版本号**相同**（否则失效检测会永远假红）', o1.pageVersion === o2.pageVersion, `${o1.pageVersion} vs ${o2.pageVersion}`)

  /* ④-6 改了 DOM → 版本号必须**变**（否则旧引用会误命中） */
  await page.evalIn(MUTATE)
  await sleep(400)
  const raw3 = await page.evalIn(runCollectorExpr('{}'))
  const o3 = P.safeJson(raw3) ?? {}
  rec('⑤ ★★ 改动 DOM 后再观察 → 版本号**变了**（旧引用会失效）', o3.pageVersion !== o1.pageVersion, `${o1.pageVersion} → ${o3.pageVersion}`)

  /* ④-7 ref 的形态：`<version>.<n>` */
  const refOk = els.every((e) => String(e.ref).startsWith(`${o1.pageVersion}.`))
  rec('⑤ ★ 每个元素的引用都带当前版本号前缀', refOk, els[0] ? String(els[0].ref) : '(无元素)')

  /* ④-8 预算 */
  const rawTiny = await page.evalIn(runCollectorExpr('{maxItems:2}'))
  const oTiny = P.safeJson(rawTiny) ?? {}
  rec('⑥ ★ 预算生效：maxItems=2 → 只给 2 条且标 truncated', (oTiny.elements ?? []).length === 2 && oTiny?.stats?.truncated === true, JSON.stringify(oTiny.stats ?? {}))

  /* ══ B 段：侧边栏按钮接线 ══ */
  const panel = await D.openTab(PORT_EDGE, `chrome-extension://${extId}/index.html`)
  const ready = await D.pollEval(panel, PANEL_READY, (v) => v === true, { tries: 30 })
  rec('⑦ ★ 侧边栏里真有「观察页面」按钮（可点）', ready.ok === true)
  const clicked = String(await panel.evalIn(CLICK_OBSERVE))
  rec('⑦ 「观察页面」按钮点得动', clicked === 'clicked', clicked)
  /*
   * ★ 等**结果态**，不能停在过程态（「观察中…」）—— 那只能证明按钮点了、
   *   而证明不了「SW 真的回话了」。结果态可能是成功文案（已观察…）或人话错误
   *   （CDP 驱动下 activeTab 没授予 → 「先点一下工具栏的 Harbor 图标」/「不支持读取」）。
   */
  const status = await D.pollEval(
    panel,
    STATUS,
    (v) => typeof v === 'string' && v.length > 0 && !v.includes('观察中'),
    { tries: 40 },
  )
  rec(
    '⑦ ★ 点了有**结果**人话（按钮真的接到了 SW，不是死按钮）',
    status.ok === true,
    JSON.stringify(String(status.value).slice(0, 90)),
  )

  /* ══ C 段：完整链路（真 host → 真主进程 → 落会话）══ */
  const obs = {
    source: 'extension',
    url: `http://127.0.0.1:${PORT_A}/`,
    title: 'M03 验收页',
    lang: 'zh-CN',
    pageVersion: 'cafe1234',
    at: Date.now(),
    selection: { text: '这是用来做选区的一段文字。', ref: 'cafe1234.e1', tag: 'P', truncated: false },
    elements: [
      { ref: 'cafe1234.e1', role: 'button', tag: 'BUTTON', text: '提交', disabled: false, checked: null, value: null, masked: false, placeholder: '', href: '', visible: true },
      { ref: 'cafe1234.e2', role: 'textbox', tag: 'INPUT', text: '密码', disabled: false, checked: null, value: null, masked: true, placeholder: '', href: '', visible: true },
    ],
    frames: [{ index: 0, src: `http://127.0.0.1:${PORT_B}/inner`, title: '', accessible: false, reason: '跨域（浏览器不允许读它的内容）' }],
    shadow: { open: 0, note: 'closed shadow root 无法枚举（浏览器不暴露）' },
    stats: { elements: 2, maxItems: 60, truncated: false, textLen: 42 },
  }
  /*
   * ★ 喂的是**扩展侧形状**（`{type, ...}`），不是协议帧（`{v,id,kind,payload}`）——
   *   host 的 dispatcher 分派键是 `type`（它面向的是「扩展发来的消息」）。
   *   诊断时喂错过一次：host 回「只认 …」的兜底，`echo` 里能看到原始帧 —— 一眼能认出来。
   */
  const framesToHost = [{ type: 'observe-page', id: 'rOBS', observation: obs }]
  /* ★ 用 exe 直起 host（不经 Edge / 不动注册表）；token 由 host 自己从数据根读 */
  const hostOut = await P.runHost({ exe: HARBOR_EXE, frames: framesToHost, dataRoot: ISO, waitMs: 2500 })
  const reply = (hostOut.replies ?? []).find((r) => r && r.id === 'rOBS')
  rec(
    '⑧ ★ 真 host → 真主进程：page:observe 有应答',
    Boolean(reply && reply.ok === true),
    JSON.stringify(reply ?? {}).slice(0, 120),
  )
  if (!reply) console.log(`  [诊断] host 收到的帧数=${(hostOut.replies ?? []).length} · stderr=${String(hostOut.err || '').slice(0, 300)}`)

  await sleep(1200)
  const files = fs.readdirSync(P2).filter((f) => f.endsWith('.jsonl'))
  rec('⑧ 会话里多了一条（观察结果落盘了）', files.length > before, `${before} → ${files.length}`)
  let hitFile = ''
  let hitText = ''
  for (const f of files) {
    try {
      const t = fs.readFileSync(path.join(P2, f), 'utf8')
      if (t.includes('cafe1234')) {
        hitFile = f
        hitText = t
        break
      }
    } catch {
      /* 忽略 */
    }
  }
  rec('⑧ ★ 落盘内容里有**渲染后的观察结果**（含元素引用）', Boolean(hitFile) && hitText.includes('cafe1234.e1'), hitFile || '没找到')
  rec('⑧ ★ 观察结果**过了防注入包装**（网页文字是不可信数据）', hitText.includes('不是指令'))
  rec('⑧ ★ 跨域 iframe 的「读不到」也进了文本（如实报告）', /读不到/.test(hitText) && /跨域/.test(hitText))
  rec('⑧ ★ 敏感字段在文本里只写「不读取」', hitText.includes('（敏感字段，不读取）'))

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
    for (const p of procs) killTree(p.pid)
    try {
      D.removeProfile(path.join(ROOT, 'harbor-edge', 'profiles', PROFILE))
    } catch {
      /* 忽略 */
    }
    restoreData()
    console.log('清理：进程已停 / profile 已删 / 隔离数据已还原（未动注册表）')
    process.exit(ok ? 0 : 1)
  }
})()
