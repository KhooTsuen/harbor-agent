/**
 * M02-A 真机验收：**Markdown 渲染** + **停止生成**
 *
 * ── 链路全真 ─────────────────────────────────────────────────
 *
 *   真 Edge + 真扩展（构建产物）→ 真侧边栏面板 → 真 host 子进程 → 真管道
 *     → 验收进程里的 ext-bridge / ext-chat（同一份代码）
 *
 * ★ 两条都要**正向 + 反向**：
 *   · Markdown：回复里给一段含**标题 / 代码块 / 表格**的文字 → 面板里必须真的
 *     渲染出 `<h2>` / `<pre>` / `<table>`（不是把 markdown 原样显示成纯文本）。
 *     反向：`whitespace-pre-wrap` 那层纯文本**不该**是正文的最终形态
 *     （它只在 Markdown 组件加载完之前兜底）。
 *   · 停止生成：① **没在跑**时点 → 必须回绝（如实说没什么可停的）；
 *     ② **有流在跑**时点 → 主进程真推 `ext:abort` 给渲染层。
 *
 * ★ 为什么要在真机验 Markdown：渲染组件是 **lazy()** 加载的（katex / CodeBlock
 *   不进首屏）—— 单测与自检**看不到**「懒加载之后到底渲没渲出来」，
 *   只有真机跑一遍才知道（这类「懒加载路径断了」的错，静态检查全看不见）。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const D = require('../lib/driver.cjs')
const P = require('../lib/ext-probe.cjs')
const S = require('../lib/ext-stage.cjs')

const ROOT = S.ROOT
const ISO = path.join(ROOT, 'data', 'unit-test-data')
const HOST_NAME = 'com.harbor.agent'
const PORT_EDGE = 9351
const PORT_PAGE = 8871
const PROFILE = 'profile-m02a'
const DIST = path.join(ROOT, 'harbor-edge', 'dist', 'sidepanel')
const STAGE = path.join(ISO, 'm02a-ext')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ★ 注册表快照：跑完必须恢复**原值**（3c 那次踩过 —— 见 m04b 的同名注释） */
const regSnap = S.snapshotRegistry(HOST_NAME)

let pass = 0
let fail = 0
const failures = []
function rec(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}  -- ${String(detail ?? '').slice(0, 150)}`)
  } else {
    fail += 1
    failures.push(name)
    console.log(`  FAIL  ${name}  -- ${String(detail ?? '').slice(0, 300)}`)
  }
}

/* ── 测试页：一份够 Markdown 发挥的正文 ── */
const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>M02-A 验收页</title></head>
<body><h1>M02-A</h1><p id="t">页面正文</p></body></html>`

/** 回复正文：同时覆盖标题 / 代码块 / 表格 / 列表 —— 渲染器少一块就能看出来 */
const REPLY = [
  '## 小标题',
  '',
  '正文里带 `行内代码`。',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
  '| 列 | 值 |',
  '|---|---|',
  '| A | 1 |',
  '',
  '- 第一项',
  '- 第二项',
].join('\n')

let server = null
const serverErrors = []
function serve(port, html) {
  const s = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  s.on('error', (e) => serverErrors.push(`端口 ${port} 起不来：${e.message}`))
  s.listen(port, '127.0.0.1')
  server = s
  return s
}

async function waitPort(port, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    try {
      /* eslint-disable-next-line no-await-in-loop */
      const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' })
      if (r.ok || r.status === 200 || r.status === 404) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  return false
}

let edge = null

async function main() {
  serve(PORT_PAGE, PAGE)
  const pageOk = (await waitPort(PORT_PAGE)) && serverErrors.length === 0
  rec('① 测试页起来了', pageOk, serverErrors.join(' | ') || `:${PORT_PAGE}`)
  if (!pageOk) return false

  /* ── 本进程起桥 + 真 ext-chat（停止那条判据靠它）── */
  process.env.HARBOR_UNIT_TEST = '1'
  const B = require(path.join(ROOT, 'electron/core/ext-bridge.cjs'))
  const EC = require(path.join(ROOT, 'electron/core/ext-command.cjs'))
  const C = require(path.join(ROOT, 'electron/core/ext-chat.cjs'))
  const Proto = require(path.join(ROOT, 'electron/core/ext-protocol.cjs'))
  const session = require(path.join(ROOT, 'electron/core/session.cjs'))
  const audit = require(path.join(ROOT, 'electron/core/audit.cjs'))
  const { wrapWebText } = require(path.join(ROOT, 'electron/core/tools/_web-note.cjs'))

  const pushed = []
  const bridge = B.createBridge()
  const command = EC.createCommand({
    getBridge: () => bridge,
    log: { info: () => {}, warn: () => {} },
    land: (kind, result, meta) => bridge.landAction(kind, result, meta),
  })
  /* 渲染层 → 主进程的那条路：这里用个假 streams（停止要靠它判「在不在跑」） */
  const streams = new Map()
  const chatRelay = C.createChatRelay({
    streams,
    getMainWindow: () => ({}),
    send: (ch, payload) => pushed.push({ ch, payload }),
    log: { info: () => {}, warn: () => {} },
  })
  const started = bridge.start({
    dataDir: ISO,
    send: () => {},
    session,
    audit,
    wrap: wrapWebText,
    log: { info: () => {}, warn: () => {} },
    chat: chatRelay,
    command,
  })
  rec('② 验收进程里的桥起来了（真管道）', started.ok === true, started.name)
  if (!started.ok) return false

  /* ── 起 Edge（产品 manifest 的副本带 host_permissions，理由同 m04a）── */
  /* ★ 先把产物复制成**带 host_permissions 的副本**：产品 manifest 刻意没有它，
     而 CDP 驱动下 activeTab 不会授予（accept-phase2 ⑧ 记过）→ 真注入会失败。 */
  const staged = P.stageExtension(DIST, STAGE)
  rec('③b 扩展副本已就位（带 host_permissions）', staged.hasManifest === true, staged.dir)
  S.regDel(HOST_NAME)
  edge = await D.launchEdge({ profileName: PROFILE, port: PORT_EDGE, extDir: staged.dir, waitMs: 2500 })
  rec('③ Edge 起来了（隔离 profile）', Boolean(edge && edge.child), `pid=${edge && edge.child && edge.child.pid}`)

  let extId = ''
  for (let i = 0; i < 20 && !extId; i += 1) {
    /* eslint-disable-next-line no-await-in-loop */
    await sleep(500)
    try {
      extId = D.readExtIdFromProfile(edge.profile, staged.dir)
    } catch {
      extId = ''
    }
  }
  rec('④ 真扩展被加载（副本，带 host_permissions）', Boolean(extId), String(extId))
  if (!extId) return false

  const stagedHost = S.stageHost({ dataDir: ISO, extId, name: HOST_NAME, tag: 'm02a' })
  rec('⑤ 装好隔离 host', fs.existsSync(stagedHost.exe), stagedHost.cmd)

  /* 测试页在前台（读页面 / activeTab 都需要它） */
  const pageTab = await D.openTab(PORT_EDGE, `http://127.0.0.1:${PORT_PAGE}/`)
  await sleep(1500)

  /* ── ⑥ 打开面板 ──
     ⚠️ **这里仍是「新开扩展页标签」，不是真侧栏** —— 已知不合格，待改。
     2026-10-20 用户指出正确做法：「先打开一个页面，再在『插件』里点侧栏插件」。
     真侧栏的正确做法已做出来了（`lib/ext-panel.cjs` 用 Input.dispatchMouseEvent
     派真实鼠标事件触发 sidePanel.open()），`accept-ownership.cjs` 已改用并 19/19 通过。
     本脚本还没改：它的判据涉及流式 / 停止生成，需单独复核改路径后是否仍成立。
     ★ 原注释「点工具栏图标走不通（原生 UI 无 CDP target）」是**错的** —— 把一个
        **局部事实**（CDP 的 Input 域确实点不到浏览器 UI）错误推广成了整体结论。
        2026-10-20 实测完整结果：
          · CDP Input.dispatchMouseEvent 只作用于页面内容 → 点不到工具栏 ✔（这半句对）
          · UIA 能枚举工具栏按钮；鼠标注入（SetCursorPos + SendInput）**能**点它
          · 真障碍是另一个：--load-extension 装的扩展**默认不在工具栏**，
            且 edge://extensions 的 DOM 在 CDP 里读不到 → 没法自动固定图标
        所以「点图标」只能人点、脚本判 → tools/accept-toolbar-entry.cjs */
  const panel = await D.openTab(PORT_EDGE, `chrome-extension://${extId}/index.html`)
  await sleep(2500)
  rec('⑥ 面板打开了（⚠️ 扩展页标签，非真侧栏）', Boolean(panel), 'index.html')

  /* 等扩展连上 Harbor */
  let conn = 0
  for (let i = 0; i < 24 && conn === 0; i += 1) {
    try {
      conn = bridge.connectionCount()
    } catch {
      conn = 0
    }
    /* eslint-disable-next-line no-await-in-loop */
    if (conn === 0) await sleep(500)
  }
  rec('⑦ 扩展连上 Harbor 的管道', conn > 0, `连接数=${conn}`)
  if (conn === 0) return false

  /* ── ⑧ 反向判据：**没在跑**时点「停止生成」→ 必须回绝 ── */
  const stopBtnExists = await panel.evalIn(`!!document.querySelector('[aria-label="停止生成"]')`)
  rec('⑧ 没在跑时**没有**停止按钮（没得停就不该有）', stopBtnExists !== true, String(stopBtnExists))
  const noRun = chatRelay.handleAbort({ sessionId: 'sess_nothing' })
  rec(
    '⑧ ★★ 没在跑时请求停止 → 如实回绝（不假装停成功）',
    noRun.ok === false && /没有正在跑的回复/.test(String(noRun.error && noRun.error.message)),
    JSON.stringify(noRun.error),
  )

  /*
   * ── ⑨ 让面板显示一段 Markdown 正文 + 进入「流式中」──
   *
   * ★ 走**真链路**，不造假数据：面板订阅的是 `chat:event`；而「面板中途打开、
   *   问上次流到哪」这条路本来就是 `chat-resume`（见 ChatPanel 的注释）。
   *   所以：主进程先有份**快照**（= 渲染层正在跑），面板切到那条会话 →
   *   它自动问 `chat-resume` → 拿到全文 → 渲染。这比硬塞分片真实得多。
   *
   * ⚠️ 为什么不能只推 `chat:event` 分片：面板没发过消息时它手上没有 turn，
   *   `setTurn(prev => prev ? … : prev)` 会把分片**全丢掉**（既有设计：没有
   *   一轮就不该凭空长出一轮）。所以必须走 resume。
   */
  streams.set('req_m02a', { sessionId: 'sess_m02a' })
  chatRelay.onChatEvent({ requestId: 'req_m02a', type: 'content', text: REPLY })
  const snap = chatRelay.snapshotOf('req_m02a')
  rec('⑨ 主进程侧有了一份流快照（模拟渲染层正在跑）', Boolean(snap && String(snap.text).includes('小标题')), snap ? `seq=${snap.seq}` : '(无)')
  await panel.evalIn(`(function(){ if(!globalThis.__m){globalThis.__m=[];chrome.runtime.onMessage.addListener(function(m){try{globalThis.__m.push(m&&m.type==='harbor-push'?('push:'+(m.push&&m.push.kind)):String(m&&m.type))}catch(e){}})} return 'hooked' })()`)
  const pushRes = bridge.push(Proto.KIND.SESSION_SELECTED, { sessionId: 'sess_m02a' })
  console.log('  [诊断] 推送结果 =', JSON.stringify(pushRes))
  await sleep(4000)
  const gotMsgs = String(await panel.evalIn(`String(globalThis.__m || 'none')`))
  const stor = String(await panel.evalIn(`new Promise(function(r){chrome.storage.local.get(['harborSelected','harborState'],function(o){r(JSON.stringify(o))})})`))
  const diagTitle = String(await panel.evalIn(`(document.querySelector('[aria-label="当前对话"]') || {}).innerText || ''`))
  const panelUrl = String(await panel.evalIn(`location.href`))
  console.log('  [诊断] 面板收到的消息 =', gotMsgs.slice(0, 220))
  console.log('  [诊断] storage =', stor.slice(0, 200))
  console.log('  [诊断] 顶栏当前对话 =', JSON.stringify(diagTitle.slice(0, 60)), '· url =', panelUrl.slice(0, 70))
  const rootInfo = String(await panel.evalIn(`(function(){const r=document.getElementById('root');return JSON.stringify({len:r?r.innerHTML.length:-1,txt:(document.body||{}).innerText?document.body.innerText.slice(0,80):'(无)',topbar:!!document.querySelector('[aria-label="顶栏"]'),input:!!document.querySelector('[aria-label="消息输入框"]')})})()`))
  console.log('  [诊断] root =', rootInfo)
  const errs = String(await panel.evalIn(`JSON.stringify(globalThis.__errs || '(未捕获)')`))
  console.log('  [诊断] 页面错误 =', errs.slice(0, 300))
  /* ── ⑩ Markdown 真的渲染了吗（这是本批最值钱的一条）── */
  const dom = String(
    await panel.evalIn(
      `(function(){
         const body = document.querySelector('[aria-label="回复正文"]');
         if (!body) return 'no-body';
         return JSON.stringify({
           pre: body.querySelectorAll('pre').length,
           table: body.querySelectorAll('table').length,
           li: body.querySelectorAll('li').length,
           code: body.querySelectorAll('code').length,
           /* 标题：主应用的渲染器**刻意**用 <p>+字号（不改真 <h*>，见 Blocks.tsx 注释）——
              所以按「粗体块」判，不按标签名判 */
           bold: body.querySelectorAll('p.font-semibold, h1, h2, h3').length,
           raw: body.innerText.slice(0, 200)
         });
       })()`,
    ),
  )
  console.log('  [诊断] 正文 DOM =', dom)
  let shape = null
  try {
    shape = JSON.parse(dom)
  } catch {
    shape = null
  }
  /*
   * ★★ 最本质的一条：**markdown 语法被消费掉了**。
   * 判据：正文里不该再出现 `## ` / ``` ``` ``` / 表格分隔行 `|---|` ——
   * 出现了就说明它还是纯文本（那是拆之前的行为）。
   */
  const rawText = String(shape?.raw ?? '')
  rec('⑩ ★★ Markdown 语法被消费掉（不再是纯文本原样显示）', rawText.length > 0 && !/##\s/.test(rawText) && !/```/.test(rawText) && !/\|---/.test(rawText), rawText.slice(0, 90))
  rec('⑩ ★★ 标题渲染成标题块（粗体 + 字号）', Boolean(shape && shape.bold > 0), dom)
  rec('⑩ ★★ 代码块渲染成 <pre>', Boolean(shape && shape.pre > 0), dom)
  rec('⑩ ★★ 表格渲染成 <table>（表格最容易在窄面板里被降级）', Boolean(shape && shape.table > 0), dom)
  rec('⑩ ★ 列表渲染成 <li>', Boolean(shape && shape.li > 0), dom)

  /* ── ⑪ 有流在跑时：出现「停止生成」按钮 ── */
  const stopBtn = await panel.evalIn(`!!document.querySelector('[aria-label="停止生成"]')`)
  rec('⑪ ★ 流式中出现了「停止生成」按钮', stopBtn === true, String(stopBtn))

  /* ── ⑫ 点它 → 主进程真收到 chat:abort 并推 ext:abort 给渲染层 ── */
  /* 先让 ext-chat 那边认为「这条会话在跑」（streams 里放一条 —— 真机里由渲染层 set） */
  streams.set('req_m02a', { sessionId: 'sess_m02a' })
  const clicked = await panel.evalIn(P.CLICK_STOP_EXPR)
  rec('⑫ 停止按钮点得动', clicked === 'clicked', String(clicked))
  await sleep(1500)
  const abortPush = pushed.find((p) => p.payload && p.payload.type === 'ext:abort')
  rec('⑫ ★★ 主进程真的把「停止」转给了渲染层（ext:abort）', Boolean(abortPush), JSON.stringify(pushed.map((p) => p.payload && p.payload.type)))
  rec('⑫ ★★ 转的是那条会话（不误伤别的对话）', Boolean(abortPush && abortPush.payload.sessionId === 'sess_m02a'), JSON.stringify(abortPush && abortPush.payload))
  rec('⑫ ★ 走的是 chat:event 通道（零新增 IPC 通道）', Boolean(abortPush && abortPush.ch === 'chat:event'))

  /* ── ⑬ 状态行给了人话（「已请求停止」），不是静默 ── */
  const statusText = String(await panel.evalIn(P.STATUS_TEXT_EXPR))
  rec('⑬ ★ 状态行说了人话（已请求停止 / 或如实说停不了）', /停止|停不了|没什么可停/.test(statusText), statusText.slice(0, 80))

  return true
}

void (async () => {
  let ok = false
  try {
    ok = await main()
  } catch (error) {
    console.log('  [异常]', (error && error.stack) || error)
  } finally {
    try {
      if (edge) D.killEdge(edge.child.pid)
    } catch {
      /* 忽略 */
    }
    try {
      server?.close()
    } catch {
      /* 忽略 */
    }
    console.log(`\n==== ${pass}/${pass + fail} 通过 ====`)
    if (failures.length) console.log('失败：\n  - ' + failures.join('\n  - '))
    /* 清理：注册表恢复**真原值**（不信「已恢复」，回读比对 —— 与 m04b/m04d 同一口径） */
    try {
      const rr = S.restoreRegistry(HOST_NAME, regSnap.value)
      console.log(`清理：注册表实际值 = ${rr.actual || '(键不存在)'}`)
      console.log(`      真原值       = ${regSnap.value || '(无)'} → ${rr.ok === true ? '✓ 一致' : '✗ 不一致'}`)
    } catch (error) {
      console.log('清理：注册表恢复失败', String(error))
    }
    try {
      S.unstageHost({ dataDir: ISO, tag: 'm02a' })
    } catch {
      /* 忽略 */
    }
    if (edge) {
      try {
        D.removeProfile(edge.profile)
      } catch {
        /* 忽略 */
      }
    }
    console.log('清理：profile 已删 / 隔离 host 已卸')
    process.exit(fail > 0 || !ok ? 1 : 0)
  }
})()
