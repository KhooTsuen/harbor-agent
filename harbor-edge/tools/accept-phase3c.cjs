/**
 * Phase 3c 真机验收：侧边栏选会话 / 没选中时新建 / ＋ 新建。
 *
 * 链路全真：真源码树 Harbor（新渲染层）+ 真 Edge + 真扩展 + 真 host + 假上游。
 * 与 3b 同一套资产（driver / ext-probe / ext-stage / fake-upstream）。
 *
 *   ① 选会话：点抽屉里第二条 → 侧边栏切过去（**主窗口不动** —— 断言它没变）
 *   ② 没选中时发消息 → 自动新建一条（两侧都出现）
 *   ③ 顶栏 ＋ → 新建一条并切过去
 *   ④ 回归：选中的那条发消息能流式回来（3b 未坏）
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const D = require('../lib/driver.cjs')
const P = require('../lib/ext-probe.cjs')
const S = require('../lib/ext-stage.cjs')

const ROOT = S.ROOT
const ISO = path.join(ROOT, 'data', 'unit-test-data')
const CONF = path.join(ISO, 'config.json')
const CRED = path.join(ISO, 'credentials.json')
const HOST_NAME = 'com.harbor.agent'
const PORT_EDGE = 9341
const PORT_APP = 9382
const PORT_VITE = 5276
const FAKE_PORT = 9981
const PROFILE = 'profile-3c'
const DIST = path.join(ROOT, 'harbor-edge', 'dist', 'sidepanel')

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  -- ${detail}`)
}
const sleep = P.sleep

/* ── 隔离数据：config 指向假上游（slow）+ 假凭证 ── */
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
const baseCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'))
fs.mkdirSync(ISO, { recursive: true })
baseCfg.providers[0].baseUrl = `http://127.0.0.1:${FAKE_PORT}/v1-slow`
if (baseCfg.general) baseCfg.general.defaultWorkdir = path.join(ISO, 'chat')
fs.writeFileSync(CONF, JSON.stringify(baseCfg, null, 2))
fs.writeFileSync(CRED, JSON.stringify({ version: 1, backend: 'plain', entries: { 'provider:deepseek': { key: 'sk-fake' } } }))

/* ── 注册表真原值（外部备份过的，见 lib/ext-stage.cjs 的文件头）── */
const regKey = `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`
const regSnap = S.snapshotRegistry(HOST_NAME)

/* ★ 起 Edge **之前**先摘注册表：否则 SW 一启动就连上旧 host，换注册表不会让它重连 */
S.regDel(HOST_NAME)

const procs = []
const upstream = spawn(process.execPath, [path.join(ROOT, 'tools', 'fake-upstream.mjs')], {
  cwd: ROOT,
  env: { ...process.env, FAKE_PORT: String(FAKE_PORT), FAKE_SLOW_MS: '800' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
procs.push(upstream)
upstream.stdout.on('data', (b) => process.stdout.write(`  [上游] ${b}`))
upstream.stderr.on('data', () => {})

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
let cdp = null

/* 侧边栏里的动作（按 aria-label 找 —— 见 ext-probe-panel.cjs 的锚点表） */
const OPEN_DRAWER = P.CLICK_TITLE_EXPR
/*
 * 点一条**不是当前选中**的会话。
 * ★ 不能用「固定点第二条」：自动新建之后那条新会话就在列表里，点它 = 值不变 → 假红。
 */
const PICK_OTHER = `(function(){
  const sec = document.querySelector('[aria-label="Harbor 会话列表"]');
  if (!sec) return 'no-list';
  const btns = [...sec.querySelectorAll('button')].filter(b => b.getAttribute('aria-current') !== 'true');
  if (!btns.length) return 'no-other';
  btns[0].click();
  return 'clicked:' + (btns[0].getAttribute('aria-label') || '').slice(0, 30);
})()`
const SELECTED_TITLE = P.TITLE_EXPR
/*
 * ★ 读「**Harbor 主窗口**当前打开的是哪条」—— 必须问主进程。
 *   上一版我读 `[aria-label="当前对话"]`，那是**侧边栏自己**的锚点（App.tsx 里的），
 *   主窗口里根本没有 → 读回空串 → 「主窗口没被切走」成了 `'' === ''` 的**假绿**。
 *   `session:active` 回的就是主窗口那条（渲染层上报的），这才是判据要的东西。
 */
const MAIN_ACTIVE = `(async()=>{ try{ const r = await chrome.runtime.sendMessage({type:'session-active'}); return String((r && r.sessionId) || '') }catch(e){ return 'ERR' } })()`
const NEW_BTN = `(function(){
  const b = document.querySelector('[aria-label="新建对话"]');
  if (!b) return false;
  b.click();
  return true;
})()`
const fill = (t) =>
  `(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(t)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`
const SEND = `(function(){const b=[...document.querySelectorAll('button')].find(x=>/发送/.test((x.textContent||'').trim()));if(!b)return false;b.click();return true})()`
const REPLY = `(function(){const e=document.querySelector('[aria-label="回复正文"]');return e?e.innerText:''})()`

const stagedBox = { cmd: null, manifest: null }

async function main() {
  const cdpLib = await import(require('node:url').pathToFileURL(path.join(ROOT, 'tools', 'shot', 'cdp.mjs')).href)
  const json = await cdpLib.findPageTarget(PORT_APP, { timeoutMs: 90000 })
  cdp = await cdpLib.connect(json.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const ev = (expr, label) => cdpLib.evaluate(cdp, expr, { label })

  /* ① 主窗口就绪 */
  let ready = false
  for (let i = 0; i < 90 && !ready; i += 1) {
    await sleep(500)
    ready = await ev(`!!document.querySelector('textarea')`, '等主窗口')
  }
  rec('① 源码树主窗口就绪（渲染层是新版）', ready === true, ready ? 'ok' : '90 次没等到')

  /* ② 在 Harbor 里建两条会话（给侧边栏可选的条目） */
  const NEW_CHAT = `(function(){const re=/^新建对话/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`
  await ev(NEW_CHAT, '新建对话1')
  await sleep(1500)
  await ev(`(function(){const t=document.querySelector('textarea');return !!t})()`, 'sanity')
  await ev(NEW_CHAT, '新建对话2')
  await sleep(1500)

  /* ③ 起 Edge + 装隔离 host */
  const sessionsBefore = fs.existsSync(path.join(ISO, 'sessions'))
    ? fs.readdirSync(path.join(ISO, 'sessions')).filter((f) => f.endsWith('.jsonl')).length
    : 0
  edge = await D.launchEdge({ profileName: PROFILE, port: PORT_EDGE, extDir: DIST, waitMs: 2500 })
  rec('② Edge 起来了（隔离 profile）', edge.ready === true, `pid=${edge.child.pid}`)
  let extId = null
  for (let i = 0; i < 40 && !extId; i += 1) {
    await sleep(500)
    extId = D.readExtIdFromProfile(edge.profile, DIST)
  }
  rec('③ 真扩展被加载', Boolean(extId), String(extId))

  const staged = S.stageHost({ dataDir: ISO, extId, name: HOST_NAME, tag: 'p3c' })
  stagedBox.cmd = staged.cmd
  stagedBox.manifest = staged.manifest
  rec('④ 装好隔离 host', fs.existsSync(staged.cmd), staged.cmd)

  /* ④ 打开侧边栏，等「已连接」 */
  const extUrl = `chrome-extension://${extId}/index.html`
  const panel = await D.openTab(PORT_EDGE, extUrl)
  const conn = await D.pollEval(panel, `(document.querySelector('[aria-label="连接状态"]')||{}).innerText||''`, (v) => v === '已连接', { tries: 40 })
  rec('⑤ 侧边栏显示「已连接」', conn.ok === true, String(conn.value))
  /*
   * ★ ⑤b 的判据换成「**host 进程的命令行里是 repo 的 native-host.cjs**」：
   *   上一版想靠 host stderr 落盘为证，但 `stageHost` 写的 .cmd **没有**
   *   重定向 stderr（3b 那脚本是自己额外做的，我记错了）→ 文件恒空 = 假红。
   */
  const hostMine = (() => {
    const out = spawnSync('wmic', ['process', 'where', "name='Harbor.exe'", 'get', 'CommandLine', '/format:csv'], { encoding: 'utf8' }).stdout ?? ''
    return String(out).includes(path.join(ROOT, 'electron', 'native-host.cjs'))
  })()
  rec('⑤b ★ 连上的是我装的 host（进程命令行含 repo native-host.cjs）', hostMine, hostMine ? '是我的' : '没找到')

  /* ⑤ 打开抽屉，看有几条可选 */
  await panel.evalIn(OPEN_DRAWER)
  const list = await D.pollEval(panel, P.SESSION_LIST_EXPR, (v) => {
    const o = P.safeJson(v)
    return Boolean(o && o.found === true && o.count > 0)
  }, { tries: 30 })
  const shown = P.safeJson(list.value) ?? {}
  rec('⑥ 抽屉里列出会话', list.ok === true, `条数=${shown.count}`)

  /* ── ★ 判据 0（用户报的 bug 2 原场景）：**一条都没选**时发消息 → 自动新建 ──
     必须在 ⑦「选中某条」之前做：一旦选中过，主进程那套就有值了，回不到未选中态。 */
  await panel.evalIn(`(function(){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));return 1})()`)
  await sleep(600)
  const titleUnsel = String(await panel.evalIn(SELECTED_TITLE))
  rec('⑥b ★ 还没选过会话（标题是「未选对话」）', /未选/.test(titleUnsel), titleUnsel.slice(0, 24))

  await panel.evalIn(fill('三c 未选中直接发'))
  await sleep(300)
  await panel.evalIn(SEND)
  const unselStream = await D.pollEval(panel, REPLY, (v) => typeof v === 'string' && v.includes('慢2'), { tries: 60 })
  rec('⑥c ★ 未选中时发消息 → 自动新建并流式回来', unselStream.ok === true, JSON.stringify(String(unselStream.value).slice(0, 30)))
  await sleep(4000)
  const titleAfterUnsel = String(await panel.evalIn(SELECTED_TITLE))
  rec(
    '⑥d ★ 发完之后侧边栏**有**了会话（不再是「未选对话」）',
    !/未选/.test(titleAfterUnsel) && Boolean(titleAfterUnsel),
    titleAfterUnsel.slice(0, 24),
  )
  /* 等这一轮跑完，免得干扰后面的切换 */
  await D.pollEval(panel, REPLY, (v) => typeof v === 'string' && v.includes('慢12'), { tries: 120 })

  /* ── ★ 判据 1：点抽屉里**另一条** → 侧边栏切过去，主窗口不动 ── */
  const mainBefore = String(await panel.evalIn(MAIN_ACTIVE))
  /* 先把抽屉打开（⑥c 之后它可能是收着的） */
  const drawerNow = P.safeJson(await panel.evalIn(P.SESSION_LIST_EXPR)) ?? {}
  if (drawerNow.found !== true) await panel.evalIn(OPEN_DRAWER)
  await sleep(500)
  const picks = await panel.evalIn(PICK_OTHER)
  await sleep(1200)
  const selAfter = String(await panel.evalIn(SELECTED_TITLE))
  const mainAfter = String(await panel.evalIn(MAIN_ACTIVE))
  const drawerGone = P.safeJson(await panel.evalIn(P.SESSION_LIST_EXPR)) ?? {}
  rec('⑦ ★ 点另一条 → 侧边栏切过去了', String(picks).startsWith('clicked') && Boolean(selAfter), `${picks} → 选中=${selAfter.slice(0, 30)}`)
  rec('⑦ 选完抽屉自动收起', drawerGone.found === false, `found=${drawerGone.found}`)
  rec(
    '⑦ ★ 主窗口**没有**被切走（用户拍板：只切侧边栏）',
    Boolean(mainBefore) && mainAfter === mainBefore && selAfter !== mainBefore,
    `主窗口=${mainBefore.slice(0, 24)}（不变）· 侧边栏=${selAfter.slice(0, 24)}`,
  )

  /* ── ★ 判据 2：选中的那条能发消息、流式回来（3b 未坏） ── */
  await panel.evalIn(fill('三c 第二条'))
  await sleep(300)
  await panel.evalIn(SEND)
  const part = await D.pollEval(panel, REPLY, (v) => typeof v === 'string' && v.includes('慢2'), { tries: 40 })
  rec('⑧ ★ 发给「侧边栏选中的那条」→ 逐片流式回来', part.ok === true, JSON.stringify(String(part.value).slice(0, 40)))

  /* 等这一轮跑完（慢速上游 12 片 × 800ms） */
  const done = await D.pollEval(panel, REPLY, (v) => typeof v === 'string' && v.includes('慢12'), { tries: 120 })
  rec('⑨ 一轮跑完（末片到了）', done.ok === true, JSON.stringify(String(done.value).slice(-30)))

  /* ── ★ 判据 3：顶栏 ＋ → 新建一条 ── */
  const beforeNew = String(await panel.evalIn(SELECTED_TITLE))
  const mainBeforeNew = String(await panel.evalIn(MAIN_ACTIVE))
  const clickedNew = await panel.evalIn(NEW_BTN)
  await sleep(2500)
  const afterNew = String(await panel.evalIn(SELECTED_TITLE))
  const mainAfterNew = String(await panel.evalIn(MAIN_ACTIVE))
  rec('⑩ ★ 点 ＋ → 出现了一条新对话（标题变了）', clickedNew === true && afterNew !== beforeNew, `${beforeNew.slice(0, 20)} → ${afterNew.slice(0, 20)}`)
  rec(
    '⑩ ＋ 新建时主窗口**也**切过去了（这条拍板是两侧切）',
    Boolean(mainAfterNew) && mainAfterNew !== mainBeforeNew,
    `主窗口 ${mainBeforeNew.slice(0, 20)} → ${mainAfterNew.slice(0, 20)} · 侧边栏=${afterNew.slice(0, 20)}`,
  )

  /* ── ★ 判据 4：在**新会话**里发一条 → 真的落盘（用户报的 bug 2 场景） ──
     注意：点 ＋ 只建**本地**会话（`pending_…`），磁盘文件要到第一次发送时才建 ——
     所以这里必须真发一条，判据才有意义（3b 那次「>= 3」是假绿，因为隔离根里早有一堆）。 */
  await panel.evalIn(fill('三c 新建后第一条'))
  await sleep(300)
  await panel.evalIn(SEND)
  const newFlow = await D.pollEval(panel, REPLY, (v) => typeof v === 'string' && v.includes('慢2'), { tries: 60 })
  rec('⑪ ★ 在新会话里发消息 → 流式回来', newFlow.ok === true, JSON.stringify(String(newFlow.value).slice(0, 30)))
  await sleep(2500)

  const files = fs.readdirSync(path.join(ISO, 'sessions')).filter((f) => f.endsWith('.jsonl'))
  rec('⑪ 新建**真的落盘**了（sessions 里多了文件）', files.length > sessionsBefore, `${sessionsBefore} → ${files.length}`)
  const hit = files.some((f) => {
    try {
      return fs.readFileSync(path.join(ISO, 'sessions', f), 'utf8').includes('三c 新建后第一条')
    } catch {
      return false
    }
  })
  rec('⑪ 落盘那条里**真有**我发的话（不是空文件）', hit, hit ? '找到了' : '没找到')

  /* ── 收尾：报告 ── */
  const pass = results.filter((r) => r.pass).length
  console.log(`\n==== ${pass}/${results.length} 通过 ====`)
  if (pass !== results.length) {
    console.log('失败：')
    for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name}`)
  }
  return pass === results.length
}

/* .cjs 里没有顶层 await —— 包成 async 立即调用（3b 踩过这个） */
void (async () => {
  let ok = false
  try {
    ok = await main()
  } catch (error) {
    console.log('验收脚本异常：', error && error.stack ? error.stack : String(error))
  } finally {
    /* ★ 清理：注册表恢复 / 卸隔离 host / 关我起的进程 / 删 profile */
    /*
     * ★ 恢复用**外部备份过的真原值**（`S.snapshotRegistry`，见 ext-stage 的文件头）。
     *   原来这里用「开跑时现读的值」当原值 —— 上一轮若没恢复成功，读到的就是**隔离值**，
     *   于是「恢复成隔离值 + 回读一致」→ 打印「✓ 一致」而用户那条其实早被覆盖了
     *   （2026-10-16 实测踩到：注册表停在 p3c-manifest.json）。
     * ★ 并且**回读比对**、不一致就判失败（不再无条件打印「已恢复」）。
     */
    let regSame = true
    try {
      const rr = S.restoreRegistry(HOST_NAME, regSnap.value)
      regSame = rr.ok
      console.log(`清理：注册表实际值 = ${rr.actual || '(键不存在)'}`)
      console.log(`      真原值       = ${rr.want || '(无)'} → ${rr.ok ? '✓ 一致' : '✗ 不一致（要手工 reg ADD 回原值）'}`)
      if (regSnap.polluted) console.log('      ⚠ 备份里也是个隔离值 —— 原值可能早已被覆盖，请人工确认')
    } catch {
      regSame = false
      console.log('清理：注册表恢复失败 —— 请手工确认 com.harbor.agent')
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
      D.removeProfile(path.join(ROOT, 'harbor-edge', 'profiles', PROFILE))
    } catch {
      /* 忽略 */
    }
    restoreData()
    /* ★ 这里**不再**说「注册表已恢复」—— 那句改由上面的回读打印（实际值 + 比对） */
    console.log('清理：隔离 host 已卸 / profile 已删 / 隔离数据已还原')
    process.exit(ok ? 0 : 1)
  }
})()
