/**
 * Phase 3b 真机验收：**侧边栏发消息 → 流式回复 → 落进同一条会话**
 *
 * 链路全真，只有模型是假的：
 *   真 Edge + 真扩展 → 真 native host（纯 Node 模式跑 repo 的 native-host.cjs）
 *   → 真命名管道 → **真源码树 Electron**（真内核）→ 真 loop → 真 HTTP → 假上游
 *   → 回复经 chat:event 一边给主窗口、一边经管道推回侧边栏
 *
 * 为什么用源码树实例（不是 dist-portable 的打包版）：3b 改的是**渲染层**
 *   （`useExtBridge` 收 `ext:send` 去 sendMessage）—— 打包版里是旧渲染层，
 *   跑起来只会「点了发送没反应」。所以这里起 `vite + electron .`。
 *
 * 数据隔离：`HARBOR_UNIT_TEST=1` → 数据根切到 `data/unit-test-data`，
 *   连 host 也指到那儿（管道名由数据根算出来，两边必须一致）。
 *   **完全不碰**真 `data/`（与 vitest / 自检同一套开关）。
 *
 *   node harbor-edge/tools/accept-phase3b.cjs
 *
 * 假上游用 `slow` 模式（`FAKE_SLOW_MS` 压到 800ms）—— 一个模式验三件事：
 *   ① 流式是**逐片**推的（每片间隔 > 50ms 合批窗口，不会被合成一片）
 *   ② 一轮跑着的时候再发 → 必须被 SESSION_BUSY 拒掉
 *   ③ 收尾后 assistant 真的落了盘（读会话文件，比读 DOM 更硬）
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
const PORT_EDGE = 9339
const PORT_APP = 9378
const PORT_VITE = 5274
const FAKE_PORT = 9978
const PROFILE = 'profile-3b'
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
const ref = baseCfg.providers[0].credentialRef
fs.mkdirSync(ISO, { recursive: true })
baseCfg.providers[0].baseUrl = `http://127.0.0.1:${FAKE_PORT}/v1-slow`
/* 会话工作目录也指到隔离区，免得落进真的对话目录 */
if (baseCfg.general) baseCfg.general.defaultWorkdir = path.join(ISO, 'chat')
fs.writeFileSync(CONF, JSON.stringify(baseCfg, null, 2))
fs.writeFileSync(
  CRED,
  JSON.stringify({ version: 1, backend: 'plain', entries: { [ref]: { value: 'sk-e2e', updatedAt: Date.now() } } }, null, 2),
)

/* ── 起假上游 / vite / Electron / Edge ── */
const procs = []
const upstream = spawn(process.execPath, [path.join(ROOT, 'tools', 'fake-upstream.mjs')], {
  cwd: ROOT,
  env: { ...process.env, FAKE_PORT: String(FAKE_PORT), FAKE_SLOW_MS: '800' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
procs.push(upstream)
const vite = spawn('npx', ['vite', '--port', String(PORT_VITE), '--strictPort'], {
  cwd: ROOT,
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
procs.push(vite)
const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${PORT_APP}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VITE_DEV_SERVER_URL: `http://localhost:${PORT_VITE}`, HARBOR_UNIT_TEST: '1' },
})
procs.push(app)

const killTree = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })

let edge = null
let cdp = null
/*
 * 注册表**真原值**（跑完恢复）：走共享快照 —— 「现读一次」当原值会被上一轮的
 * 隔离值污染（2026-10-16 实测踩到，见 lib/ext-stage.cjs 的文件头）。
 */
const regSnap = S.snapshotRegistry(HOST_NAME)

const NEW_CHAT = `(function(){const re=/^新建对话/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`
const fill = (t) =>
  `(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(t)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`
const SEND = `(function(){const b=[...document.querySelectorAll('button')].find(x=>/发送/.test((x.textContent||'').trim()));if(!b)return false;b.click();return true})()`
/** 侧边栏当前显示的回复正文（3b 新增的那块） */
const REPLY_TEXT = `(function(){const e=document.querySelector('[aria-label="回复正文"]');return e?e.innerText:''})()`
const NOTICE_TEXT = `(function(){const e=document.querySelector('[aria-label="发送提示"]');return e?e.innerText:''})()`
/*
 * 「面板挂载好了」的判据。
 *
 * ⚠️ 两个按钮的**找法不一样**，这是 Phase 3b 布局返工踩出来的：
 *   · 「发送」是**带文字**的按钮 → 按 textContent 找。
 *   · 「读当前页」被压成了**图标按钮**（没有文字）→ 只能按 `aria-label` 找。
 *   以前两者都按 textContent 找，返工后这一条会**永远不成立**（判据静默失效）。
 */
const PANEL_READY = `JSON.stringify({
  send: [...document.querySelectorAll('button')].some(b => /发送/.test((b.textContent||'').trim())),
  read: !!document.querySelector('[aria-label="读当前页"]'),
  title: !!document.querySelector('[aria-label="选择对话"]'),
})`

/*
 * 「杀掉旧 host」那一版（`killStrayHosts`）已删 —— 它只杀**指向 repo 路径**的 host，
 * 漏掉了「旧注册表指向 dist-portable」这种情形（本轮就栽在这里）。
 * 现在改成**起 Edge 前先摘注册表**（见 main() 里那段注释），确定性更好，
 * 而且**完全不碰**任何正在跑的 host 进程（更安全）。
 */

async function main() {
  /* ── ① 等 vite 起来，再等主窗口的界面就绪 ── */
  const cdpLib = await import(require('node:url').pathToFileURL(path.join(ROOT, 'tools', 'shot', 'cdp.mjs')).href)
  const json = await cdpLib.findPageTarget(PORT_APP, { timeoutMs: 60000 })
  cdp = await cdpLib.connect(json.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const ev = (expr, label) => cdpLib.evaluate(cdp, expr, { label })

  let ready = false
  for (let i = 0; i < 60 && !ready; i += 1) {
    await sleep(500)
    ready = await ev(`!!document.querySelector('textarea')`, '等主窗口')
  }
  rec('① 源码树主窗口就绪（渲染层是新版）', ready === true, ready ? 'textarea 出现' : '60 次没等到')

  /* ── ② 新建一条对话（让主进程有「当前打开的会话」） ── */
  await ev(NEW_CHAT, '新建对话')
  await sleep(1500)

  /*
   * ── ★ 起 Edge **之前**先摘掉注册表 ──
   *
   * 为什么（3b 真机 + 本轮复跑各红一次，两次都是它）：
   *   Edge 一起来，SW 立刻按**当时**的注册表 `connectNative` —— 等我们读到 extId
   *   再去改注册表，它**已经连上旧的那台 host 了**，而换注册表**不会**让它重连。
   *   上一版的修法是「杀掉指向 **repo 路径** 的 host」：那漏掉了「旧注册表指向
   *   dist-portable」这一情形（本轮就是这么红的 —— 我的 host 从头到尾没被拉起，
   *   ⑥b 的 stderr 文件根本没生成）。
   *
   * 改成确定性做法：**先摘** → SW 首次必失败 → 我装好隔离 host 后它自己重连
   * （`native.js` 的 `RECONNECT_MS = 3000`，判据 ⑥b 最多等 15s）。
   *
   * ⚠️ 副作用：若用户此刻正开着 Edge 用扩展，他会短暂看到「未连接」。
   *    脚本跑完在 `finally` 里恢复**真原值**（`S.snapshotRegistry` 的外部备份）。
   */
  S.regDel(HOST_NAME)

  /* ── ③ 起 Edge + 扩展，装隔离 host ── */
  edge = await D.launchEdge({ profileName: PROFILE, port: PORT_EDGE, extDir: DIST, waitMs: 2500 })
  rec('② Edge 起来了（隔离 profile）', edge.ready === true, `pid=${edge.child.pid}`)

  let extId = null
  for (let i = 0; i < 40 && !extId; i += 1) {
    await sleep(500)
    extId = D.readExtIdFromProfile(edge.profile, DIST)
  }
  rec('③ 真扩展被加载', Boolean(extId), String(extId))

  /* 注册表上面已摘掉 → 现在装我的，SW 会在 3s 内重连上来（见前面那段注释） */
  S.stageHost({ dataDir: ISO, extId, name: HOST_NAME, tag: 'p3b' })
  /*
   * ★ 诊断：把 host 的 **stderr 落到文件**。
   *   Edge 拉起的 host 进程 stderr 没人接（浏览器丢掉）—— 而 host 的诊断（「已就绪」
   *   「丢弃一帧」「推送转发失败」…）全在 stderr 上。协议通道是 **stdout**，不受影响。
   */
  {
    const cmdFile = path.join(ISO, 'p3b-host.cmd')
    const errFile = path.join(ISO, 'p3b-host.err')
    fs.rmSync(errFile, { force: true })
    const body = fs.readFileSync(cmdFile, 'utf8')
    fs.writeFileSync(cmdFile, body.replace(/(\r?\n?)$/, ` 2>> "${errFile}"$1`), 'ascii')
  }
  rec('④ 装好隔离 host（真 exe / 真机制 / 数据根=unit-test-data）', true, path.join(ISO, 'p3b-host.cmd'))

  /* ── ④ 打开侧边栏页面，等它连上 ── */
  const panel = await D.openTab(PORT_EDGE, `chrome-extension://${extId}/index.html`)
  let mounted = false
  for (let i = 0; i < 40 && !mounted; i += 1) {
    await sleep(500)
    const raw = String(await panel.evalIn(PANEL_READY))
    try {
      const o = JSON.parse(raw)
      mounted = o.send === true && o.read === true && o.title === true
    } catch {
      mounted = false
    }
  }
  rec('⑤ 侧边栏挂载出「发送」输入区 + 顶栏（读页面按钮在）', mounted === true, mounted ? '按钮齐' : '没等到')
  const conn = await D.pollEval(panel, `(function(){const h=document.querySelector('header');return h?h.innerText:''})()`, (v) => typeof v === 'string' && v.includes('已连接'), { tries: 40 })
  rec('⑥ 侧边栏显示「已连接」（SW 自动重连上真 host）', conn.ok === true, String(conn.value).slice(0, 40))
  /*
   * ★ 判「连上的**是我的** host」—— 光看「已连接」不够：ping/pong 由 host 自己答，
   *   连上旧宿主也显示「已连接」。**我的 host 才会往这个 stderr 文件里写东西**
   *   （`.cmd` 里那行 `2>> file` 是我加的），所以文件出现 = 我的 host 真的被拉起了。
   */
  const errFile0 = path.join(ISO, 'p3b-host.err')
  let mine = false
  for (let i = 0; i < 30 && !mine; i += 1) {
    await sleep(500)
    mine = fs.existsSync(errFile0) && fs.readFileSync(errFile0, 'utf8').includes('已就绪')
  }
  rec('⑥b ★ 连上的是**我装的**那台 host（stderr 落盘为证）', mine === true, mine ? 'host 已就绪' : '没等到我的 host')

  /* 发消息前先让面板知道「当前是哪条会话」 */
  const sessNow = await panel.evalIn(
    `(async()=>{ try{ const r = await chrome.runtime.sendMessage({type:'session-active'}); return JSON.stringify(r) }catch(e){ return 'ERR:'+String(e&&e.message||e) } })()`,
  )
  console.log('  [诊断] 面板问 session-active ->', String(sessNow).slice(0, 120))
  const btnState = await panel.evalIn(
    `JSON.stringify([...document.querySelectorAll('button')].filter(b=>/发送/.test((b.textContent||'').trim())).map(b=>b.disabled))`,
  )
  console.log('  [诊断] 发送按钮 disabled =', String(btnState))
  await sleep(1200)

  /* ── ⑤ 正向：从侧边栏发一条 → 看逐片流式 ── */
  const typed = await panel.evalIn(fill('侧边栏发的第一条'))
  rec('⑦ 侧边栏输入框可写', typed === '侧边栏发的第一条'.length, `写入 ${typed} 字`)
  await sleep(400)
  const sent = await panel.evalIn(SEND)
  rec('⑧ 侧边栏「发送」可点', sent === true, sent ? '已点' : '没找到按钮')
  await sleep(1500)
  const afterSend = await panel.evalIn(
    `(function(){const n=document.querySelector('[aria-label="发送提示"]');const e=document.querySelector('[aria-label="回复错误"]');const r=document.querySelector('[aria-label="回复正文"]');return JSON.stringify({notice:n?n.innerText:null,err:e?e.innerText:null,reply:r?r.innerText:null})})()`,
  )
  console.log('  [诊断] 发送后 1.5 秒 ->', String(afterSend).slice(0, 200))

  /* 逐片出现：慢速上游每 800ms 一片，等到「慢2」说明真的是一片片来的 */
  const part = await D.pollEval(panel, REPLY_TEXT, (v) => typeof v === 'string' && v.includes('慢2'), { tries: 40 })
  rec('⑨ ★ 侧边栏看到流式分片（逐片到，不是一次刷完）', part.ok === true, JSON.stringify(String(part.value).slice(0, 60)))

  /* ── ⑥ 负向：这一轮还在跑，再发一条 → SESSION_BUSY ── */
  await panel.evalIn(fill('第二条（此时上一条还在跑）'))
  await sleep(300)
  await panel.evalIn(SEND)
  const busy = await D.pollEval(panel, NOTICE_TEXT, (v) => typeof v === 'string' && v.length > 0, { tries: 30 })
  rec(
    '⑩ ★ 会话忙时被拒 + 人话（不静默排队）',
    /正在别处运行/.test(String(busy.value)),
    JSON.stringify(String(busy.value).slice(0, 60)),
  )

  /* ── ⑦ 等这一轮收尾（12 片 × 800ms） ── */
  const done = await D.pollEval(panel, REPLY_TEXT, (v) => typeof v === 'string' && v.includes('慢12'), { tries: 60 })
  rec('⑪ 一轮跑完（末片到了）', done.ok === true, JSON.stringify(String(done.value).slice(-40)))

  /* ── ⑧ 落盘：读会话文件（比读 DOM 更硬 —— C-α 的「渲染层落盘」直接证据） ── */
  const dir = path.join(ISO, 'sessions')
  const runStart = Date.now() - 5000 /* 只认**本轮**写的文件（隔离目录会攒旧文件） */
  let found = null
  for (let i = 0; i < 30 && !found; i += 1) {
    await sleep(500)
    let files = []
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      /* 目录还没建 */
    }
    for (const f of files) {
      const full = path.join(dir, f)
      if (fs.statSync(full).mtimeMs < runStart) continue
      const text = fs.readFileSync(full, 'utf8')
      if (text.includes('慢12') && text.includes('侧边栏发的第一条')) {
        found = { file: f, text }
        break
      }
    }
  }
  rec(
    '⑫ ★ assistant 回复**落了盘**（同一条会话里有提问 + 回复）',
    Boolean(found),
    found ? found.file : '会话文件里没等到',
  )
  if (found) {
    const lines = found.text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    const roles = lines.filter((m) => m.type === 'message').map((m) => m.role)
    rec('⑬ 会话里是先 user 再 assistant（顺序对）', roles.includes('user') && roles.includes('assistant'), roles.join(','))
  }

  /* ── ⑨ 主窗口也能看到：它打开的就是这条会话（读渲染层 DOM） ── */
  const inMain = await ev(
    `(function(){const t=document.body.innerText;return {hasAsk:t.includes('侧边栏发的第一条'),hasReply:t.includes('慢12')}})()`,
    '主窗口消息区',
  )
  rec(
    '⑭ ★ 主窗口同一条会话里也能看到这条回复（两处同一条）',
    inMain && inMain.hasAsk === true && inMain.hasReply === true,
    JSON.stringify(inMain),
  )
}

let exitCode = 1
async function run() {
  try {
    await main()
    const passed = results.filter((r) => r.pass).length
    console.log(`\n==== ${passed}/${results.length} 通过 ====`)
    exitCode = passed === results.length ? 0 : 1
  } catch (error) {
    console.error('验收脚本异常：', error instanceof Error ? error.message : error)
  } finally {
    /* host 视角（stderr）—— 上面判据全绿也值得看一眼有没有 warn */
    try {
      const errFile = path.join(ISO, 'p3b-host.err')
      const t = fs.readFileSync(errFile, 'utf8')
      console.log('--- host stderr（末 12 行）---')
      console.log(t.split(/\r?\n/).filter(Boolean).slice(-12).join('\n'))
    } catch (e) {
      console.log('--- host stderr：读不到（', e.message, '）---')
    }
    try {
      cdp?.ws?.close()
    } catch {
      /* 忽略 */
    }
    if (edge) D.killEdge(edge.child.pid)
    for (const p of procs) killTree(p.pid)
    await sleep(600)
    /* ★ 恢复**真原值** + 回读比对（不一致就记一条失败 —— 别再无条件的「已恢复」）*/
    const rr = S.restoreRegistry(HOST_NAME, regSnap.value)
    console.log(`清理：注册表实际值 = ${rr.actual || '(键不存在)'}`)
    rec(
      '清理：注册表恢复到真原值',
      rr.ok === true && regSnap.polluted !== true,
      `${rr.actual || '(键不存在)'} vs ${rr.want || '(无)'}${regSnap.polluted ? ' ⚠ 备份里也是隔离值，原值可能早已被覆盖' : ''}`,
    )
    S.unstageHost({ dataDir: ISO, tag: 'p3b' })
    if (edge) D.removeProfile(edge.profile)
    restoreData()
    /* ★ 这里**不再**说「注册表已恢复」—— 那句改由上面的回读打印（真值 + 比对） */
    console.log('清理：隔离 host 已卸 / profile 已删 / 隔离数据已还原')
  }
  process.exit(exitCode)
}

void run()
