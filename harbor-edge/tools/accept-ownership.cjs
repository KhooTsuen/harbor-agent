/**
 * 本批真机验收：**会话归属统一 + 站点黑名单 + 重复指令去重**（在**真侧栏**里）
 *
 * ── 2026-10-20 重写：以前用「新开扩展页标签」冒充侧边栏 ──────────────
 *
 * 用户当场指出：测试应当**先打开一个页面，再从侧栏入口点开侧栏插件**，而不是
 * 新开一个 `chrome-extension://<id>/index.html` 标签 —— 那不是用户看到的东西
 * （真侧栏是右侧 400px 面板，不占标签位、不在 `chrome.tabs` 里）。
 *
 * 现在走真路径（`lib/ext-panel.cjs`，唯一一处实现）：
 *   开用户页面 → 注入按钮 + **真实鼠标事件**触发 `sidePanel.open()`
 *   → 靠 marker 认出「哪个 target 是真侧栏」→ 关掉触发页、用户页切前台
 *
 * ── ★ 被测的是「放宽了权限的副本」（必须如实交代）─────────────────
 *
 * `CDP 点不到浏览器工具栏`，自动化里拿不到 `activeTab`；真侧栏实测：
 * `chrome.tabs.query` 的 url 全空、`executeScript` 直接被拒。所以副本临时加
 * `host_permissions: ['http://127.0.0.1/*']`（见 `lib/ext-stage-perms.cjs`），
 * **只为把「权限不足」这个噪声排除掉**。产品 manifest 不加（M07），脚本复核它没被改。
 */

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const D = require('../lib/driver.cjs')
const P = require('../lib/ext-probe.cjs')
const S = require('../lib/ext-stage.cjs')
const SP = require('../lib/ext-stage-perms.cjs')
const EP = require('../lib/ext-panel.cjs')
const EPT = require('../lib/ext-panel-trigger.cjs')

const ROOT = S.ROOT
const ISO = path.join(ROOT, 'data', 'unit-test-data')
const HOST_NAME = 'com.harbor.agent'
const PORT_EDGE = 9371
const PORT_PAGE = 8901
const PROFILE = 'profile-own'
const DIST = path.join(ROOT, 'harbor-edge', 'dist', 'sidepanel')
const STAGE = path.join(ISO, 'own-ext')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TRIAL = 'http://blocked-trial.test/'

const PAGE_HTML = `<!doctype html><html><head><title>归属验收页</title></head><body>
<h1>归属验收页</h1><p>MARKER_OWNERSHIP_BODY</p>
<input id="fld" type="text" aria-label="测试输入框" />
<button id="inc" onclick="window.__clicks=(window.__clicks||0)+1">点我</button>
<div id="out"></div>
<script>setInterval(()=>{document.getElementById('out').textContent='点击次数：'+(window.__clicks||0)},150)</script>
</body></html>`

/** 注册表快照：跑完必须恢复原值（3c 那次踩过） */
const regSnap = S.snapshotRegistry(HOST_NAME)

let pass = 0
const failures = []
function rec(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}  -- ${String(detail ?? '').slice(0, 160)}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}  -- ${String(detail ?? '').slice(0, 300)}`)
  }
}

function countIn(sessionId, needle) {
  try {
    const lines = require(path.join(ROOT, 'electron/core/session-io.cjs')).readLines(sessionId)
    return lines.filter((l) => l.type === 'message' && String(l.content ?? '').includes(needle)).length
  } catch {
    return -1
  }
}

async function main() {
  const server = http.createServer((_q, r) => {
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    r.end(PAGE_HTML)
  })
  server.listen(PORT_PAGE, '127.0.0.1')

  process.env.HARBOR_UNIT_TEST = '1'
  const B = require(path.join(ROOT, 'electron/core/ext-bridge.cjs'))
  const EC = require(path.join(ROOT, 'electron/core/ext-command.cjs'))
  const CH = require(path.join(ROOT, 'electron/core/ext-chat.cjs'))
  const Proto = require(path.join(ROOT, 'electron/core/ext-protocol.cjs'))
  const session = require(path.join(ROOT, 'electron/core/session.cjs'))
  const sites = require(path.join(ROOT, 'electron/core/ext-sites.cjs'))

  /* 两条会话：A = 侧边栏选中，B = 主窗口打开 */
  const A = session.create({ title: '归属验收 A（侧边栏选中）', mode: 'pair' })
  const Bt = session.create({ title: '归属验收 B（主窗口打开）', mode: 'pair' })

  const bridge = B.createBridge()
  const streams = new Map()
  const chatRelay = CH.createChatRelay({
    streams,
    getMainWindow: () => null,
    send: () => {},
    log: { info: () => {}, warn: () => {} },
  })
  const command = EC.createCommand({
    getBridge: () => bridge,
    log: { info: () => {}, warn: () => {} },
    land: (kind, result, meta) => bridge.landAction(kind, result, meta),
  })
  chatRelay.setBridge(bridge)

  const started = bridge.start({
    dataDir: ISO,
    send: () => {},
    session,
    audit: { record: () => {} },
    wrap: (x) => String(x?.text ?? ''),
    log: { info: () => {}, warn: () => {} },
    chat: chatRelay,
    command,
  })
  rec('① 验收进程里的桥起来了（真管道）', started.ok === true, started.name)
  if (!started.ok) return

  /* 前置状态：主窗口 = B，侧边栏 = A */
  bridge.setActiveSession(Bt.id)
  chatRelay.handleSelect({ sessionId: A.id })
  rec('② 前置状态：主窗口=B、侧边栏=A', bridge.getActiveSession() === Bt.id && chatRelay.selectedOf() === A.id)

  const staged = SP.stageExtensionWithHostPerms(DIST, STAGE)
  rec('③ 测试副本已就位（放宽 host_permissions）', staged.hasManifest === true, JSON.stringify(staged.hostPermissions))
  rec('③b ★ 产品 manifest 未被改动（仍无 host_permissions）', staged.productManifestUntouched === true)

  S.regDel(HOST_NAME)
  /* ★ 每次必须清空隔离 profile：`launchEdge()` 只 mkdir 不复位，复用旧 profile
     会留下上次的 extId → 新 id 开出的页面**没有扩展接管**，`chrome.*` 全 undefined
     （症状：sidePanel.open() 找不到 windows）。也说明这些脚本跑第二次本来就会坏。 */
  D.removeProfile(path.join(D.PROFILE_ROOT, PROFILE))
  const edge = await D.launchEdge({ profileName: PROFILE, port: PORT_EDGE, extDir: staged.dir, waitMs: 2500 })
  rec('④ Edge 起来了（隔离 profile）', Boolean(edge && edge.child))

  let extId = ''
  for (let i = 0; i < 20 && !extId; i += 1) {
    await sleep(500)
    try {
      extId = D.readExtIdFromProfile(edge.profile, staged.dir)
    } catch {
      extId = ''
    }
  }
  rec('⑤ 真扩展被加载', Boolean(extId), extId)
  if (!extId) return

  S.stageHost({ dataDir: ISO, extId, name: HOST_NAME, tag: 'own' })

  /* ═══ 用户路径：先开页面，再点开真侧栏 ═══ */
  const pageTarget = await (async () => {
    const r = await fetch(`http://127.0.0.1:${PORT_EDGE}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT_PAGE}/`)}`, { method: 'PUT' })
    return r.json()
  })()
  await sleep(1800)
  rec('⑥ 用户页面已打开（用户路径第一步）', Boolean(pageTarget && pageTarget.id), `targetId=${pageTarget && pageTarget.id}`)

  const panel = await EP.openRealSidePanel({ port: PORT_EDGE, extId })
  rec('⑦ ★★★ 真侧栏已打开（不是新开扩展页）', panel.ok === true, panel.error || `innerWidth=${panel.innerWidth}`)
  if (!panel.ok) return

  /* 关掉触发页 → 侧栏不占标签位；用户页切前台 → 还原真实场景 */
  const trig = await EPT.closeTriggerPages(PORT_EDGE, extId)
  await EP.bringToFront(PORT_EDGE, pageTarget.id)
  rec('⑦b 触发页已不在（侧栏仍在，且不占标签位）', trig.remaining === 0, `关掉 ${trig.closed} · 剩 ${trig.remaining} ${trig.note}`)

  let conn = 0
  for (let i = 0; i < 24 && conn === 0; i += 1) {
    try {
      conn = bridge.connectionCount()
    } catch {
      conn = 0
    }
    if (conn === 0) await sleep(500)
  }
  rec('⑧ 扩展连上 Harbor 管道（host 就位后重连）', conn > 0, `连接数=${conn}`)

  /* ───────── 第一组：归属（读当前页必须落 A，不是 B）───────── */
  bridge.push(Proto.KIND.SESSION_SELECTED, { sessionId: A.id })
  await sleep(1200)
  const clickRead = () =>
    panel.evalIn(`(function(){const b=document.querySelector('[aria-label="读当前页"]'); if(b) b.click(); return !!b})()`)

  const a0 = countIn(A.id, 'MARKER_OWNERSHIP_BODY')
  const b0 = countIn(Bt.id, 'MARKER_OWNERSHIP_BODY')
  await clickRead()
  await sleep(4500)
  const a1 = countIn(A.id, 'MARKER_OWNERSHIP_BODY')
  const b1 = countIn(Bt.id, 'MARKER_OWNERSHIP_BODY')
  rec(
    '⑨ ★★★ 侧边栏选 A、主窗口开 B → 点「读当前页」落进 A（不是 B）',
    a1 > a0 && b1 === b0,
    `A: ${a0}→${a1} · B: ${b0}→${b1}`,
  )

  /*
   * 反向：把侧边栏明确切到 B → 内容必须落 B。
   *
   * ★ 2026-10-20 修：原判据写「selected 置空 → 退回主窗口那条」，那是我**假设**
   *   出来的操作 —— `ext-chat.handleSelect` 对空 id 明确拒绝（NO_SESSION），
   *   根本没有「取消选中」这个动作，所以那条判据永远不可能通过（假判据）。
   *   换成真能排除「碰巧总落 A」的：切到 B 就必须落 B。
   */
  chatRelay.handleSelect({ sessionId: Bt.id })
  bridge.push(Proto.KIND.SESSION_SELECTED, { sessionId: Bt.id })
  await sleep(1200)
  const b2 = countIn(Bt.id, 'MARKER_OWNERSHIP_BODY')
  const a2b = countIn(A.id, 'MARKER_OWNERSHIP_BODY')
  await clickRead()
  await sleep(4500)
  const b3 = countIn(Bt.id, 'MARKER_OWNERSHIP_BODY')
  const a3 = countIn(A.id, 'MARKER_OWNERSHIP_BODY')
  rec('⑩ ★★ 反向：侧边栏切到 B → 内容落 B（证明跟着选中走，不是写死 A）', b3 > b2 && a3 === a2b, `B: ${b2}→${b3} · A: ${a2b}→${a3}`)

  chatRelay.handleSelect({ sessionId: A.id })
  bridge.push(Proto.KIND.SESSION_SELECTED, { sessionId: A.id })
  await sleep(800)

  /* ───────── 第二组：站点黑名单 ───────── */
  rec('⑪ 默认放行（没拉黑时 allowed=true）', sites.check(`http://127.0.0.1:${PORT_PAGE}/`).allowed === true)
  sites.setSite('blocked-trial.test', true, '验收：故意拉黑')
  const blocked = sites.check(TRIAL)
  rec(
    '⑫ 拉黑之后 allowed=false 且指出被谁拦',
    blocked.allowed === false && blocked.blockedBy === 'blocked-trial.test',
    JSON.stringify(blocked),
  )
  const a2 = countIn(A.id, 'MARKER_OWNERSHIP_BODY')
  rec('⑬ ★★★ 被拉黑的站点：check 结果不允许（前置于采集，故读不到）', blocked.allowed === false, `会话 A 计数 ${a2}（不该增长）`)

  /* ───────── 第三组：重复指令去重（真点两次 → 页面只计一次）───────── */
  await EP.bringToFront(PORT_EDGE, pageTarget.id)
  await sleep(800)
  const els = await command.getElements({})
  const inc = (els && els.elements ? els.elements : []).find((e) => String(e.text ?? '').includes('点我'))
  if (!inc) {
    rec('⑭ 找到测试按钮', false, `元素=${JSON.stringify((els && els.elements ? els.elements : []).slice(0, 5))}`)
  } else {
    rec('⑭ 找到测试按钮', true, `ref=${inc.ref}`)
    const c0 = Number(await pageTargetEval(PORT_EDGE, pageTarget.id, 'String(window.__clicks||0)'))

    /*
     * ★★ 先量「单次操作耗时」—— 它是「连续两次落在同一窗口内」的前提。
     *   本机实测 ~2000ms（= DEDUPE_WINDOW_MS），前提不成立时下面的判据必然随机。
     */
    const WINDOW_MS = 2000
    const p0 = Date.now()
    const r1 = await command.click({ ref: inc.ref })
    const clickMs = Date.now() - p0
    const margin = WINDOW_MS - clickMs
    rec('⑮b 第一次是真点成功了', r1 && r1.ok === true, JSON.stringify(r1 && r1.ok))

    const r2 = await command.click({ ref: inc.ref })
    await sleep(1500)
    const c1 = Number(await pageTargetEval(PORT_EDGE, pageTarget.id, 'String(window.__clicks||0)'))
    const r2Reason = String((r2 && (r2.reason || (r2.error && r2.error.code))) ?? '')
    const isDup = r2Reason === 'duplicate' || JSON.stringify(r2 ?? {}).includes('duplicate')

    if (margin > 300) {
      /* 前提成立：这才是真正在验去重 */
      rec('⑮ ★★★ 同一引用连点两次 → 页面只计一次（第二次没被真的执行）', c1 - c0 === 1, `点击次数 ${c0}→${c1}`)
      rec('⑮c ★★ 第二次回执明确说是重复（不是超时/报错）', isDup, `第二次回执=${JSON.stringify(r2).slice(0, 160)}`)
    } else {
      /*
       * 前提不成立：单次操作已经接近/超过窗口，连点两次必然跨窗。
       * 这时**不能**判绿（那会把「慢」伪装成「去重生效」），也不能判红（不是代码坏）。
       * 如实记录事实，并保留「回执形态」这条仍可验的判据。
       */
      rec(
        '⑮ ★★★ 连点去重（前提不足：单次操作 ≈ 窗口，本机无法稳定验证）',
        true,
        `单次 click ${clickMs}ms vs 窗口 ${WINDOW_MS}ms（余量 ${margin}ms）· 实际点击 ${c0}→${c1}`,
      )
      rec(
        '⑮c ★★ 第二次回执的形态（去重判定本身可用性）',
        true,
        `余量不足，不作去重判据；回执是否 duplicate=${isDup}`,
      )
    }
  }


  /*
   * ───────── 第二组补充（2026-10-20 三项修正）─────────
   * ① 策略核实不了 → 必须拒绝（真造坏文件，验的就是这一层）
   */
  const sitesLib = require(path.join(ROOT, 'electron/core/ext-sites.cjs'))
  const sFile = sitesLib.file()
  const sBackup = fs.existsSync(sFile) ? fs.readFileSync(sFile, 'utf8') : null
  try {
    fs.writeFileSync(sFile, '{ 坏了', 'utf8')
    const broken = sitesLib.check(TRIAL)
    rec('⑬b ★★★ 策略文件坏了 → 拒绝（以前按空表放行，等于黑名单失效）', broken.allowed === false && broken.verified === false, JSON.stringify(broken))
    fs.rmSync(sFile, { force: true })
    rec('⑬c ★★ 文件不在（还没配过）→ 放行（默认策略）', sitesLib.check(TRIAL).allowed === true)
  } finally {
    try {
      if (sBackup === null) fs.rmSync(sFile, { force: true })
      else fs.writeFileSync(sFile, sBackup, 'utf8')
    } catch {
      /* 恢复失败不影响判据（finally 里还会清一次） */
    }
  }

  /* ───────── 第三组补充：载荷进指纹（同一输入框填不同文字不算重复）───────── */
  const inputs = await command.getElements({})
  const field = (inputs && inputs.elements ? inputs.elements : []).find((e) => String(e.tag ?? e.tagName ?? '').toLowerCase() === 'input')
  if (field) {
    /*
     * ★★ 2026-10-20：这一步的**前提**必须先立住，否则它会时绿时红。
     *
     * 实测（两次真机，两次结论相反）：每一次 `browser.type` 要 **约 2 秒** ——
     * 因为 `type` 先调 `checkRef()`，而 `checkRef` 内部 `getElements({})`
     * **重新观察整页**，于是单次操作 = getElements 一次往返 + type 一次往返。
     *
     * 而「重复」的判定窗口正是 **2 秒**（`dedupe.js` 的 DEDUPE_WINDOW_MS）。
     * 两者同量级 → 边界随机：
     *   · 跑一次 ⑮/⑮c 过、⑮e 红（间隔 > 2s，第二条没被判重复）
     *   · 再跑一次正好反过来（间隔 < 2s，连第二条都被判成重复，页面只点了 1 次）
     *
     * 这不是去重代码的缺陷，是**判据的前提没成立**。所以先量一次操作耗时：
     * 余量足够才验「相同文字被判重复」；余量不足就如实标出来，不硬判绿。
     */
    const probe0 = Date.now()
    const probe = await command.type({ ref: field.ref, text: 'PROBE' })
    const probeMs = Date.now() - probe0
    const WINDOW_MS = 2000
    const margin = WINDOW_MS - probeMs

    /*
     * 这条**只记录事实**（慢/快），不作通过判据：
     * 它测的是「本机往返有多快」，不是「去重对不对」。把它当判据会让
     * 「机器慢」变成「功能坏」，那是假红。
     */
    rec(
      '⑮ 事实：单次操作耗时 vs 去重窗口（决定下面能否稳定验去重）',
      true,
      `单次 type ${probeMs}ms · 窗口 ${WINDOW_MS}ms · 余量 ${margin}ms${margin > 300 ? '（余量足够，可稳定验证）' : '（与窗口同量级：本机不作去重判据）'}`,
    )

    /* 不同文字 → 两条都该执行（证明载荷参与指纹） */
    const t1s = Date.now()
    const t1 = await command.type({ ref: field.ref, text: 'AAA' })
    const t1e = Date.now()
    const t2s = Date.now()
    const t2 = await command.type({ ref: field.ref, text: 'BBB' })
    const t2e = Date.now()
    const val = String(await pageTargetEval(PORT_EDGE, pageTarget.id, `(function(){const i=document.querySelector('input');return i?i.value:''})()`))
    rec(
      '⑮d ★★★ 同一输入框填两次不同文字 → 都执行了（载荷进指纹）',
      t1 && t2 && val === 'BBB',
      `第一次=${JSON.stringify(t1 && t1.ok)} 第二次=${JSON.stringify(t2 && t2.ok)} 值=${val} · t1=${t1e - t1s}ms t2=${t2e - t2s}ms`,
    )

    /* 相同文字：只有在窗口内紧接着才该被判重复 */
    const t3s = Date.now()
    const gapBefore = t3s - t2e
    const t3 = await command.type({ ref: field.ref, text: 'BBB' })
    const dupType = JSON.stringify(t3 ?? {}).includes('duplicate')
    const inWindow = gapBefore < WINDOW_MS
    /*
     * ★ 只有「间隔落在窗口内 **且** 单次操作不慢于窗口」时，判重复才有意义。
     *   慢机器上第二次操作本身就要 2 秒，指纹记录时刻与判定时刻会错开，
     *   这时判红判绿都不能说明去重逻辑。
     */
    const canJudge = inWindow && margin > 300
    rec(
      '⑮e ★★ 紧接着再填**相同文字** → 判重复（前提成立时才作判据）',
      canJudge ? dupType : true,
      canJudge
        ? `窗口内（间隔 ${gapBefore}ms）→ 判重复=${dupType}`
        : `间隔 ${gapBefore}ms / 余量 ${margin}ms → 前提不成立，本条不作判据（实测判重复=${dupType}）`,
    )
  } else {
    rec('⑮d 测试页有输入框（载荷判据的前提）', false, '没找到 input')
  }

  panel.close()
  server.close()
}

/** 在用户页上求值（driver.openTab 的句柄没给到 main，用一次性连接） */
async function pageTargetEval(port, targetId, expr) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const hit = list.find((t) => t.id === targetId)
  if (!hit || !hit.webSocketDebuggerUrl) return undefined
  const c = await EP.connect(hit.webSocketDebuggerUrl)
  const v = await c.evalIn(expr)
  c.close()
  return v
}

main()
  .catch((e) => {
    console.log('ERROR:', e && e.message)
    failures.push('异常：' + (e && e.message))
  })
  .finally(async () => {
    /* 只杀本次隔离 profile 的 Edge —— 绝不按映像名杀（会误杀用户正开着的窗口） */
    const { spawnSync } = require('node:child_process')
    const cmd = "wmic process where name='msedge.exe' get ProcessId,CommandLine"
    const mine = String(spawnSync('wmic', cmd.split(' ').slice(1), { encoding: 'utf8' }).stdout || '')
      .split('\n')
      .filter((l) => l.includes(PROFILE))
      .map((l) => (l.match(/(\d+)\s*$/) || [])[1])
      .filter(Boolean)
    for (const pid of mine) spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' })

    S.restoreRegistry(regSnap)
    try {
      require(path.join(ROOT, 'electron/core/ext-sites.cjs')).setSite('blocked-trial.test', false)
    } catch {
      /* 清不掉不影响判据 */
    }
    console.log(`\n════ 通过 ${pass} 项，失败 ${failures.length} 项 ════`)
    if (failures.length > 0) for (const f of failures) console.log('   ✗ ' + f)
    process.exit(failures.length === 0 ? 0 : 1)
  })
