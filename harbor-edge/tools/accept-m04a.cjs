/**
 * M04-1 真机验收：`browser.getElements`（元素列表 + 引用失效判定）
 *
 * 链路全真：真 Edge（隔离 profile）+ **真扩展**（`executeScript` 真注入）+ 真 host
 *          + 真源码树主进程（`page:elements` 渲染 + ref 解析 + 落盘）。
 *
 * ── ★ 为什么要用「加了 host_permissions 的副本」──────────────────
 *
 * manifest **没有** `host_permissions`（产品**刻意**不加，M07「不默认要全站权限」）；
 * 正常路径靠 **activeTab**（用户点扩展图标时授予），而 **CDP 驱动下 activeTab 不授予**
 * （accept-phase2 ⑧ 早记过）。所以验收必须给**副本**临时加 `host_permissions: 127.0.0.1/*`。
 *
 * 这不改变「产品不加权限」这条结论 —— 它验的是**注入的逻辑对不对**，
 * 不是「activeTab 授不授予」（后者是浏览器行为，phase2 ⑧ 单独验过、且已如实记录）。
 * 详见 `docs/research/edge-extension-m04-design.md` §0.1。
 *
 * 隔离：独立 profile / 隔离数据根 / 注册表**快照→恢复→回读比对** / 跑完删副本与 profile。
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
const PORT_APP = 9384
const PORT_VITE = 5278
const PORT_PAGE = 8821
const PROFILE = 'profile-m04a'
const DIST = path.join(ROOT, 'harbor-edge', 'dist', 'sidepanel')
const STAGE = path.join(ISO, 'm04a-ext')

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  -- ${detail}`)
}
const sleep = P.sleep

/* ── 隔离数据（M04-1 不调模型）── */
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
baseCfg.providers[0].baseUrl = `http://127.0.0.1:${PORT_PAGE}/v1`
if (baseCfg.general) baseCfg.general.defaultWorkdir = path.join(ISO, 'chat')
fs.writeFileSync(CONF, JSON.stringify(baseCfg, null, 2))
fs.writeFileSync(CRED, JSON.stringify({ version: 1, backend: 'plain', entries: { 'provider:deepseek': { key: 'sk-fake' } } }))

/* ── 注册表：快照 → 摘 → 装隔离 → 最后恢复 + **回读比对**（3c 那次的教训）── */
const regKey = `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`
const regOld = spawnSync('reg', ['QUERY', regKey, '/ve'], { encoding: 'utf8' }).stdout ?? ''
S.regDel(HOST_NAME)

/* ── 测试页（可交互元素 + 一个用来改 DOM 的锚点）── */
const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>M04 验收页</title></head><body>
<h1>M04 验收页</h1>
<button id="ok">提交</button>
<input id="txt" placeholder="请输入名字">
<a href="/next">下一步</a>
<input type="checkbox" id="cb" checked>
</body></html>`
const pageServer = http.createServer((_q, r) => {
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  r.end(PAGE)
})
pageServer.listen(PORT_PAGE, '127.0.0.1')

/* ── 副本：加 host_permissions（只在副本里，不改产品 manifest）── */
fs.rmSync(STAGE, { recursive: true, force: true })
fs.cpSync(DIST, STAGE, { recursive: true })
const mf = path.join(STAGE, 'manifest.json')
const m = JSON.parse(fs.readFileSync(mf, 'utf8'))
m.host_permissions = ['http://127.0.0.1/*']
fs.writeFileSync(mf, JSON.stringify(m, null, 2))

/* ── 源码树实例（主进程要有最新的 ext-ops / ext-observe）── */
const procs = []
const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT_VITE), '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
})
procs.push(vite)
vite.stdout.on('data', () => {})
vite.stderr.on('data', () => {})
/*
 * ★ electron **不能**在这里就 spawn：`VITE_DEV_SERVER_URL` 指向 vite，
 *   而 vite 还没 ready 时页面会**加载失败且不重试** → 主窗口永远空白
 *   （判据 ⓪ 会红，看起来像「主进程有 bug」）。所以等 vite 通了再起（见 main）。
 */
const killTree = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })

let edge = null
const stagedBox = { cmd: null, manifest: null }

/** 在侧边栏页面里发 `get-elements`（真 SW 收到 → 真注入 → 真回执） */
const GET_ELEMENTS = (ref) =>
  `(async()=>{ try{ const r = await chrome.runtime.sendMessage({type:'get-elements', ref:${JSON.stringify(ref || '')}}); return JSON.stringify(r) }catch(e){ return 'ERR:'+String((e&&e.message)||e) } })()`

/**
 * 把某个 target 带到前台。
 *
 * ★ 为什么必须显式做：SW 取的是「**前台**当前标签」，而 CDP 附着到某个 target
 *   **会把它激活** —— 于是「侧边栏页」在几次 `panel.evalIn` 之后顶掉了测试页，
 *   现象是后面几次调用报「读不到当前页地址」（看起来像权限坏了，其实是前台跑偏了）。
 */
async function bringToFront(port, targetId) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/activate/${targetId}`)
  } catch {
    /* 老版本没有这个端点 —— 退化成「不切」，判据一旦红就能看出来 */
  }
  await sleep(250)
}

/** 取一次元素列表（**先确保测试页在前台**） */
async function grab(panel, pageTargetId, ref) {
  await bringToFront(PORT_EDGE, pageTargetId)
  return P.safeJson(await panel.evalIn(GET_ELEMENTS(ref)))
}

/** 改一下 DOM（用来验「版本变了 → 旧引用失效」） */
const MUTATE = `(function(){ const b=document.createElement('button'); b.textContent='新按钮'; document.body.appendChild(b); return true })()`

async function main() {
  /* ── 等 vite 就绪，**再**起 electron（否则主窗口永远空白，见上面注释）── */
  let viteOk = false
  for (let i = 0; i < 60 && !viteOk; i += 1) {
    try {
      await fetch(`http://localhost:${PORT_VITE}/`)
      viteOk = true
    } catch {
      await sleep(500)
    }
  }
  rec('⓪a vite 就绪', viteOk === true, viteOk ? `:${PORT_VITE}` : '没起来')
  if (!viteOk) return false
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${PORT_APP}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VITE_DEV_SERVER_URL: `http://localhost:${PORT_VITE}`, HARBOR_UNIT_TEST: '1' },
  })
  procs.push(app)

  /* ── ⓪ 源码树主窗口就绪 ── */
  const cdpLib = await import(require('node:url').pathToFileURL(path.join(ROOT, 'tools', 'shot', 'cdp.mjs')).href)
  const json = await cdpLib.findPageTarget(PORT_APP, { timeoutMs: 60000 })
  const mainCdp = await cdpLib.connect(json.webSocketDebuggerUrl)
  await mainCdp.send('Runtime.enable')
  const evMain = (expr) => cdpLib.evaluate(mainCdp, expr, { label: '主窗口' })
  let ready = false
  for (let i = 0; i < 60 && !ready; i += 1) {
    await sleep(500)
    ready = await evMain(`!!document.querySelector('textarea')`, '等主窗口')
  }
  rec('⓪ 源码树主窗口就绪（主进程有最新 ext-ops）', ready === true, ready ? 'ok' : '没等到')
  if (!ready) return false

  /* ── ① 起 Edge（副本）+ 装隔离 host ── */
  edge = await D.launchEdge({ profileName: PROFILE, port: PORT_EDGE, extDir: STAGE, waitMs: 2500 })
  rec('① Edge 起来了（隔离 profile）', edge.ready === true, `pid=${edge.child.pid}`)
  let extId = null
  for (let i = 0; i < 40 && !extId; i += 1) {
    await sleep(500)
    extId = D.readExtIdFromProfile(edge.profile, STAGE)
  }
  rec('② 真扩展被加载（副本，带 host_permissions）', Boolean(extId), String(extId))
  if (!extId) return false

  const staged = S.stageHost({ dataDir: ISO, extId, name: HOST_NAME, tag: 'm04a' })
  stagedBox.cmd = staged.cmd
  stagedBox.manifest = staged.manifest
  /*
   * ★ 把 host 的 **stderr 落盘**：Edge 拉起的 host 进程 stderr 没人接（浏览器丢掉），
   *   而 host 的诊断（「已就绪」/「丢弃一帧」/「连不上主进程」…）全在 stderr 上。
   *   没有它，碰到「host 没连上主进程」就只能靠猜（3b 那轮吃过这个亏）。
   *   协议通道是 **stdout**，不受影响。
   */
  const errPath = path.join(ISO, 'm04a-host.err')
  try {
    const src = fs.readFileSync(staged.cmd, 'utf8')
    fs.writeFileSync(staged.cmd, src.replace(/(Harbor\.exe"?\s+"[^"]+")/, `$1 2>"${errPath}"`), 'ascii')
  } catch {
    /* 写不进去不致命（只是少了诊断） */
  }
  rec('③ 装好隔离 host', fs.existsSync(staged.cmd), staged.cmd)

  /*
   * ★ 顺序要紧：**先开侧边栏页，再开测试页**。
   *   `resolveActiveTab` 取的是「前台当前标签」—— 后打开的那个才是前台。
   *   侧边栏只要**开着**就能发消息（不必在前台），而测试页必须是前台，
   *   否则 SW 会去访问「侧边栏页自己」（`chrome-extension://` → 命中受限页判据，
   *   现象是「该页面不支持读取」）。M03 的 B 段正是在这里**假绿**过（报告已记）。
   */
  const panel = await D.openTab(PORT_EDGE, `chrome-extension://${extId}/index.html`)
  await sleep(1200)
  /*
   * ★ 测试页句柄留着：改 DOM（MUTATE）要改的是**测试页**，不是侧边栏页 ——
   *   在侧边栏页上执行 MUTATE 会往面板里加个按钮，而测试页的指纹纹丝不动
   *   （判据 ⑧ 于是永远红，且看起来像「版本号没跟 DOM 走」这种产品 bug）。
   */
  const pageTab = await D.openTab(PORT_EDGE, `http://127.0.0.1:${PORT_PAGE}/`)
  await sleep(1500)
  rec('④ 侧边栏与测试页都开了（测试页在前台 = active）', true, 'ok')

  /* ── ④b 诊断：SW 到底连上了哪台 host？主进程日志说了什么？ ── */
  await sleep(2000)
  try {
    const err = fs.existsSync(path.join(ISO, 'm04a-host.err')) ? fs.readFileSync(path.join(ISO, 'm04a-host.err'), 'utf8') : '(没有 .err —— host 没被拉起)'
    console.log('  [诊断] host stderr =', err.replace(/\r?\n/g, ' | ').slice(0, 300))
  } catch {
    /* 忽略 */
  }
  try {
    const logDir = path.join(ISO, 'logs')
    const f = fs
      .readdirSync(logDir)
      .filter((x) => /^\d{4}-\d{2}-\d{2}\.log$/.test(x))
      .sort()
      .pop()
    const tail = fs
      .readFileSync(path.join(logDir, f), 'utf8')
      .split(/\r?\n/)
      .filter((l) => /扩展桥|侧边栏|page|token|管道/.test(l))
      .slice(-6)
      .join('\n     ')
    console.log('  [诊断] 主进程日志（桥相关）=\n     ', tail || '(没有相关行)')
  } catch (e) {
    console.log('  [诊断] 读日志失败 =', String(e && e.message))
  }

  /* ── ⑤ 第一次取元素列表 ── */
  const r1 = await grab(panel, pageTab.target.id, '')
  const ver1 = String(r1?.pageVersion ?? '')
  rec('⑤ ★ 拿回元素列表（真 executeScript 注入）', r1 && r1.ok === true && Number(r1.elements) >= 3, `条数=${r1?.elements} 版本=${ver1}`)
  console.log('  [诊断] 第一次完整返回 =', JSON.stringify(r1).slice(0, 500))
  rec('⑤ 元素列表落进了会话', Boolean(r1?.sessionId), String(r1?.sessionId ?? ''))

  /* 从会话文件里读回渲染结果 —— 验「元素 + 引用 + 防注入包装」都进了文本 */
  const sessDir = path.join(ISO, 'sessions')
  const newest = () =>
    fs
      .readdirSync(sessDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, t: fs.statSync(path.join(sessDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]?.f
  let text = ''
  try {
    text = fs.readFileSync(path.join(sessDir, newest()), 'utf8')
  } catch {
    text = ''
  }
  rec('⑤ ★ 会话里有渲染后的元素表格（含引用列）', /页面元素|可交互元素/.test(text) && /\d+\.\d+/.test(text))
  rec('⑤ ★ 网页内容**过了防注入包装**（不可信数据）', /不是指令/.test(text))

  /* ── ⑥ 同一页面再取一次 → 版本稳定 ── */
  const r2 = await grab(panel, pageTab.target.id, '')
  rec('⑥ ★ 同页面再取 → 版本号**相同**（否则失效判定会永远假红）', String(r2?.pageVersion ?? '') === ver1, `${ver1} vs ${String(r2?.pageVersion ?? '')}`)

  /* ── ⑦ 用**当前** ref 取单个 → 有效 ── */
  const curRef = `${ver1}.1`
  const r3 = await grab(panel, pageTab.target.id, curRef)
  rec('⑦ ★ 用当前 ref 取 → 有效（stale=false）', r3 && r3.ok === true && r3.stale !== true, `ref=${curRef} stale=${r3?.stale}`)

  /* ── ⑧ 改 DOM → 版本变，**旧 ref 失效** ── */
  await pageTab.evalIn(MUTATE)
  await sleep(300)
  const r4 = await grab(panel, pageTab.target.id, curRef)
  console.log('  [诊断] 旧 ref 的完整返回 =', JSON.stringify(r4).slice(0, 400))
  /*
   * ★ 判据写成 `stale === true`，**不是** `ok === false`：
   *   「引用失效」是一次**成功的查询**的结果（`ok:true` + `stale:true`），
   *   不是调用失败 —— 第一版判 `ok===false` 于是永远红（诊断打出来才发现）。
   */
  rec('⑧ ★★ 改 DOM 后 → 旧 ref **失效**（stale，不许点）', r4 && r4.stale === true, `reason=${r4?.reason} version=${r4?.pageVersion}→${r4?.pageVersionAfter}`)
  rec('⑧ 失效理由说得清（页面变了）', r4?.reason === 'page-changed', String(r4?.reason ?? ''))

  /* ── ⑨ 版本一致但 ref 不存在 → not-found ── */
  const r5first = await grab(panel, pageTab.target.id, '')
  const ver2 = String(r5first?.pageVersion ?? '')
  const r5 = await grab(panel, pageTab.target.id, `${ver2}.99`)
  console.log('  [诊断] 不存在 ref 的完整返回 =', JSON.stringify(r5).slice(0, 400))
  rec('⑨ ★ 同版本但不存在的 ref → not-found（也是失效）', r5 && r5.stale === true && r5.reason === 'not-found', `reason=${r5?.reason}`)
  rec('⑨ 改过 DOM 的版本号和改之前**不同**（指纹真的跟 DOM 走）', Boolean(ver2) && ver2 !== ver1, `${ver1} → ${ver2}`)

  return results.every((r) => r.pass)
}

void (async () => {
  let ok = false
  try {
    ok = await main()
  } catch (error) {
    console.log('验收脚本异常：', error && error.stack ? error.stack : String(error))
  } finally {
    try {
      if (regOld.trim()) {
        const val = (regOld.match(/REG_SZ\s+(.+)/) ?? [])[1]
        if (val) {
          for (const view of ['/reg:64', '/reg:32']) {
            spawnSync('reg', ['ADD', regKey, '/ve', '/t', 'REG_SZ', '/d', val.trim(), '/f', view], { encoding: 'utf8' })
          }
        } else {
          for (const view of ['/reg:64', '/reg:32']) spawnSync('reg', ['DELETE', regKey, '/f', view], { encoding: 'utf8' })
        }
      }
    } catch {
      /* 忽略 */
    }
    /* ★ 回读比对（不再无条件说「已恢复」）—— 3c 那次的教训，见 roadmap 验收资产一节 */
    let regSame = true
    try {
      const out = spawnSync('reg', ['QUERY', regKey, '/ve'], { encoding: 'utf8' }).stdout ?? ''
      const got = ((out.match(/REG_SZ\s+(.+)/) ?? [])[1] ?? '').trim()
      const want = ((regOld.match(/REG_SZ\s+(.+)/) ?? [])[1] ?? '').trim()
      regSame = got === want
      console.log(`清理：注册表实际值 = ${got || '(键不存在)'} → ${regSame ? '✓ 与原值一致' : '✗ 不一致（手工 reg ADD 回原值）'}`)
    } catch {
      regSame = false
      console.log('清理：注册表回读失败 —— 请手工确认')
    }
    if (!regSame) ok = false
    for (const f of [stagedBox.cmd, stagedBox.manifest, stagedBox.cmd ? stagedBox.cmd.replace(/\.cmd$/, '.err') : null]) {
      try {
        if (f) fs.rmSync(f, { force: true })
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
      fs.rmSync(path.join(ROOT, 'harbor-edge', 'profiles', PROFILE), { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    try {
      fs.rmSync(STAGE, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    restoreData()
    pageServer.close()
    const pass = results.filter((r) => r.pass).length
    console.log(`\n==== ${pass}/${results.length} 通过 ====`)
    if (pass !== results.length) {
      console.log('失败：')
      for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name}`)
    }
    console.log('清理：隔离 host 已卸 / profile 已删 / 副本已删 / 隔离数据已还原')
    process.exit(ok && pass === results.length ? 0 : 1)
  }
})()
