/**
 * Phase 2 真机验收：读当前页 → 送进 Harbor 会话
 *
 * 链路：真 Edge（隔离 profile）→ 真扩展 → 真 native host → 真命名管道
 *      → 真主进程桥（真 session + 真审计）→ 真会话文件。
 * A 段（host→管道→包装→落会话→审计）真机端到端；B 段（点按钮→scripting
 * 读正文）受 activeTab 的 invoke 时机限制，**实测并如实记录**，不粉饰。
 *
 * ⚠️ 这个脚本会**临时写 `com.harbor.agent` 注册表**（指到隔离 host），而且判据 ⑰
 *    还会**故意删一次**去验「删注册表不断开已建立的连接」—— 所以跑完必须恢复
 *    用户的真值。2026-10-16 起走 `S.snapshotRegistry` 的外部备份（原来只删不恢复，
 *    跑一次就把用户手工装的那条抹掉）。
 */
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const D = require('../lib/driver.cjs')
const P = require('../lib/ext-probe.cjs')
const S = require('../lib/ext-stage.cjs')
const B = require('../../electron/core/ext-bridge.cjs')

const ROOT = P.ROOT
const DIST = path.join(ROOT, 'harbor-edge', 'dist', 'sidepanel')
const STAGE = path.join(ROOT, 'harbor-edge', 'dist', 'p2-probe')
const DATA = path.join(ROOT, 'data', 'unit-test-data')
const PROFILE = 'profile-p2-e2e'
const PORT = 9480
const WEB_PORT = 8855
const HOST_NAME = 'com.harbor.agent'
const MARK = 'P2_E2E_PAGE_MARKER_77'

const session = require('../../electron/core/session.cjs')
const audit = require('../../electron/core/audit.cjs')
const { wrapWebText } = require('../../electron/core/tools/_web-note.cjs')

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  -- ${detail}`)
}

async function main() {
  /* 本地网页：可控、可复现、不联网、不碰风控站点 */
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<!doctype html><html><head><title>P2 真机验收页</title></head><body>` +
        `<h1>Harbor Phase 2</h1><p>${MARK}</p><p>${'x'.repeat(200)}</p></body></html>`,
    )
  })
  await new Promise((r) => server.listen(WEB_PORT, '127.0.0.1', r))
  const pageUrl = `http://127.0.0.1:${WEB_PORT}/`

  /* 主进程桥（真 session + 真审计；隔离数据根） */
  const pushed = []
  const bridge = B.createBridge()
  const started = bridge.start({
    dataDir: DATA,
    send: (name, payload) => pushed.push({ name, payload }),
    session,
    audit,
    wrap: wrapWebText,
    log: { info: () => {}, warn: (m) => console.log('   [桥]', m) },
  })
  rec('① 主进程桥起来了（真管道）', started.ok === true, started.name)

  const staged = P.stageExtension(DIST, STAGE)
  console.log('  产物里的 manifest =', staged.hasManifest)
  let edge = null
  const created = []
  /*
   * ★ 注册表**真原值**快照 —— 必须在写注册表之前，而且必须在 `try` **外面**。
   *
   * ⚠️ 第一版我把它写在了 `try {` 里面 → `finally` 里引用不到（`const` 是块级作用域）
   *   → 恢复那步抛 `ReferenceError`，**用户手工装的那条就再也回不来**（2026-10-16 实测）。
   *
   * 这个脚本会**故意**删一次注册表去验判据 ⑰（「删注册表不断开已建立的连接」），
   * 还临时写隔离 host 指到验收数据根 —— 跑完都得恢复用户的真值。
   * 走共享快照而不是「现读一次」：现读到的可能就是上一轮留下的隔离值。
   */
  const regSnap = S.snapshotRegistry(HOST_NAME)
  try {
    /* ── 起真 Edge + 真扩展 ── */
    edge = await D.launchEdge({ profileName: PROFILE, port: PORT, extDir: STAGE, waitMs: 2500 })
    rec('② Edge 起来了', edge.ready === true, `pid=${edge.child.pid}`)

    let extId = null
    for (let i = 0; i < 30 && !extId; i += 1) {
      await P.sleep(500)
      extId = D.readExtIdFromProfile(edge.profile, STAGE)
    }
    rec('③ 真扩展被加载（拿到真实 id）', Boolean(extId), String(extId))

    /*
     * ── 装一个**隔离的** host：真 Harbor.exe + 真 native-host.cjs + 隔离数据根 ──
     *
     * 用生产同款机制（.cmd + ELECTRON_RUN_AS_NODE），只是把路径与数据根换成
     * 验收专用的 —— 这样即使真读到页面，也只会写进 data/unit-test-data，
     * **绝不碰用户的真会话**。
     *
     * ⚠️ 注册表必须**在 Edge 起来之后**写：扩展 id 要先加载才知道。
     *   于是顺带验到一件事 —— **SW 会自动重连**（第一次 connectNative 失败，
     *    3 秒后重试，这时注册表已在，就连上了）。
     */
    const harborExe = path.join(ROOT, 'dist-portable', 'Harbor', 'Harbor.exe')
    const nhPath = path.join(ROOT, 'electron', 'native-host.cjs')
    const hostCmd = path.join(DATA, 'p2-host.cmd')
    const manifestPath = path.join(DATA, 'p2-manifest.json')
    fs.mkdirSync(DATA, { recursive: true })
    fs.writeFileSync(
      hostCmd,
      [
        '@echo off',
        'setlocal',
        'set ELECTRON_RUN_AS_NODE=1',
        `set HARBOR_DATA_ROOT=${DATA}`,
        `"${harborExe}" "${nhPath}"`,
        '',
      ].join('\r\n'),
      'ascii',
    )
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'com.harbor.agent',
        description: 'Harbor phase 2 acceptance host',
        path: hostCmd,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${extId}/`],
      }),
    )
    D.regAdd('com.harbor.agent', manifestPath)
    rec('④ 装好了隔离的 host（真 exe / 真机制 / 隔离数据根）', fs.existsSync(harborExe), hostCmd)

    /* ── 打开真实网页 ── */
    const tab1 = await D.openTab(PORT, pageUrl)
    const title = await D.pollEval(tab1, 'document.title', (v) => typeof v === 'string' && v.length > 0, {
      tries: 20,
    })
    rec('⑤ 真实网页打开了', title.ok === true, String(title.value))

    /* ── B 段：实测 activeTab 在 CDP 驱动下的真实行为（如实记录）── */
    const sw = await P.findServiceWorker(PORT, extId)
    rec('⑥ 找到扩展的 Service Worker', Boolean(sw), sw ? 'ok' : '没找到')

    if (sw) {
      const probe = await P.probeActiveTab(sw.webSocketDebuggerUrl)
      console.log('  [SW 探针]', JSON.stringify(probe))
      rec('⑦ tabs.query 拿得到当前标签', probe && probe.tabs === 1, `url=${JSON.stringify(probe?.url)}`)
      /*
       * ★ 如实记录：CDP 驱动下 activeTab **拿不到**（浏览器安全设计 ——
       *   它只在「用户真手势 invoke 扩展」时授予，脚本伪造不了）。
       *   所以脚本**无法**真机验证「点按钮读正文」那一步；
       *   能验的是「拿不到时不静默失败」，即下面 ⑨。
       */
      rec(
        '⑧ activeTab 在 CDP 驱动下的真实行为（如实记录）',
        probe?.execErr !== undefined || probe?.execOk === true,
        probe?.execOk
          ? `已授予（意外），读到 ${String(probe.execText).length} 字`
          : `未授予（符合预期）：${probe?.execErr}`,
      )

      const viaSw = await P.triggerAndPoll(
        sw.webSocketDebuggerUrl,
        `chrome.runtime.sendMessage({ type: 'read-page' })`,
        (v) => v && (v.ok === true || typeof v.error === 'string'),
      )
      console.log('  [SW 自发消息的结果（⚠️ 不是产品路径）]', JSON.stringify(viaSw))
      /*
       * ⚠️ 上面这条**说明不了产品行为**：`chrome.runtime.sendMessage` 从 SW **自己**
       *   发出时，SW 自己的 onMessage 收不到（Chrome 不投给发送者所在 context）——
       *   所以拿到的是「Receiving end does not exist」。
       *   产品里发消息的是**侧边栏页面**（另一个 context）。所以真正要验的是下面：
       *   打开侧边栏、**真点那个按钮**、读 UI 上的文案。
       */
    }

    /* ── ⑨ 侧边栏 UI：真点「读当前页」按钮，读它显示什么 ── */
    const extUrl = `chrome-extension://${extId}/index.html`
    const panel = await D.openTab(PORT, extUrl)
    /*
     * ★ 判据要按 **aria-label** 找，不能按按钮文字 —— Phase 3b 布局返工把
     *   「读当前页」压成了**图标按钮**（文字只存在于 aria-label 里），
     *   按 textContent 找会永远不成立（本轮就是这么红的）。同 `P.CLICK_READ_EXPR` 的口径。
     */
    const mounted = await D.pollEval(
      panel,
      `!!document.querySelector('[aria-label="读当前页"]') && [...document.querySelectorAll('button')].some(b => /发送/.test((b.textContent||'').trim()))`,
      (v) => v === true,
      { tries: 30 },
    )
    rec('⑨ 侧边栏页面打开、React 挂载出按钮（读页面图标 + 发送）', mounted.ok === true, String(mounted.value))

    const clickRead = P.CLICK_READ_EXPR
    await panel.evalIn(clickRead)
    const readText = await D.pollEval(panel, P.STATUS_TEXT_EXPR, P.isResultText, { tries: 30 })
    console.log('  [侧边栏读页面文案]', JSON.stringify(readText.value))
    /*
     * ⚠️ 这条验到的**具体是什么**要说清：⑨ 把活动标签换成了**扩展自己的页面**
     *   （`chrome-extension://…/index.html`），它命中 `BLOCKED_PROTOCOL` →
     *   所以文案是「该页面不支持读取」。
     *   即：**验到的是「禁止协议生效 + 早退给人话」**，不是「activeTab 拿不到」那条路
     *   （那条由下面 ⑰ 之后的分支与自检覆盖 —— 早退时根本走不到读页面那步）。
     */
    rec(
      '⑩ ★ 点「读当前页」给人话（活动标签是扩展页 → 命中禁止协议，早退）',
      readText.ok === true && /不支持读取|先点一下工具栏|读不到/.test(String(readText.value)),
      String(readText.value).slice(0, 90),
    )

    /* ── ⑪ 顶部连接状态：host 装好后 SW 自动重连，UI 应显示「已连接」── */
    const headerText = await D.pollEval(
      panel,
      `(function(){ const h = document.querySelector('header'); return h ? h.innerText : ''; })()`,
      (v) => typeof v === 'string' && v.includes('已连接'),
      { tries: 40 },
    )
    console.log('  [顶部状态]', JSON.stringify(headerText.value))
    rec('⑪ ★ 装了 host 之后侧边栏显示「已连接」（SW 自动重连成功）', headerText.ok === true, String(headerText.value).slice(0, 60))

    /*
     * ── ⑰ 如实记录：删注册表**不会**断开已建立的连接 ──
     *
     * 卸载脚本删注册表，用户会以为「马上就断」；实测**不会** —— port 一旦建立
     * 就独立于注册表，要等那条 host 进程退出（或重开 Edge）才断。
     * ⚠️ 「首次连接就失败 → 显示未连接」那条路本脚本验不了（要杀 Edge 拉起的
     *    host 进程，脚本拿不到它的 pid）；它的人话错误由自检组 156 覆盖（ENOENT）。
     */
    D.regDel('com.harbor.agent')
    await P.sleep(4500)
    const afterUnreg = await panel.evalIn(
      `(function(){ const h = document.querySelector('header'); return h ? h.innerText : '' })()`,
    )
    console.log('  [删注册表后的顶部状态]', JSON.stringify(afterUnreg))
    rec(
      '⑰ 如实记录：删注册表**不断开**已建立的连接（要 host 进程退出才断）',
      typeof afterUnreg === 'string' && afterUnreg.includes('已连接'),
      String(afterUnreg).split('\n')[0],
    )

    /* ── A 段：真机端到端（host → 管道 → 包装 → 会话 → 审计）── */
    const bodyText = await tab1.evalIn('document.body.innerText')
    const meta = session.create({ title: '浏览器：P2 真机验收', mode: 'pair' })
    created.push(meta.id)
    bridge.setActiveSession(meta.id)

    const hostBin = path.join(ROOT, 'dist-portable', 'Harbor', 'Harbor.exe')
    /*
     * 形态：**真 Harbor.exe 以纯 Node 模式跑 native-host.cjs**（生产同款机制，
     * 见 docs/research/edge-extension-host-stdout-experiments.md）。
     * 这里不用 .cmd 包装器，是因为 `.cmd` 里的 `%~dp0` 指向它**所在**目录 ——
     * 而验收要的是**隔离数据根**（写到 data/unit-test-data，绝不碰真会话）。
     * 环境变量由脚本显式给，等价于 `.cmd` 里那一行 `set HARBOR_DATA_ROOT=`。
     */
    const hostOut = await P.runHost({
      exe: hostBin,
      frames: [
        { type: 'ext:page', id: 'rE2E', url: pageUrl, title: String(title.value || ''), text: String(bodyText || ''), truncated: false },
      ],
      dataRoot: DATA,
    })
    console.log('  [host 形态] Harbor.exe + --parent-window 无关的纯 Node 模式（HARBOR_DATA_ROOT=隔离根）')
    console.log('  [Harbor.exe 在位]', fs.existsSync(hostBin))
    rec('⑪ 真 host 被拉起并回了帧', hostOut.replies.length >= 1, JSON.stringify(hostOut.replies[0] || {}).slice(0, 130))
    rec('⑫ host 报 delivered=true（字节写进了管道）', hostOut.replies[0]?.delivered === true, String(hostOut.replies[0]?.error || '-'))

    const msgs = session.load(meta.id).messages ?? []
    const lastMsg = msgs[msgs.length - 1] || {}
    const content = String(lastMsg.content ?? '')
    rec(
      '⑬ ★ 会话里真出现了被包装的内容（含页面标记）',
      content.includes('不是指令') && content.includes(MARK),
      content.slice(0, 70).replace(/\n/g, ' '),
    )
    rec('⑭ 标了 source=extension', lastMsg.source === 'extension', String(lastMsg.source))
    const audits = audit.read({ limit: 5, tool: 'ext:page' })
    rec(
      '⑮ 审计记了 source=extension',
      Boolean(audits[0]) && audits[0].extras?.source === 'extension',
      JSON.stringify(audits[0]?.extras ?? null).slice(0, 110),
    )
    rec('⑯ 渲染层收到了 ext:page 推送', pushed.some((x) => x.name === 'ext:page'), `条数=${pushed.length}`)
  } finally {
    try {
      if (edge) D.killEdge(edge.child.pid)
    } catch {
      /* 已退 */
    }
    await P.sleep(800)
    /*
     * ★ 恢复**真原值** + 回读比对：不一致就记一条失败。
     *   （原来这里是 `D.regDel(...)` —— **只删不恢复**，用户手工装的那条会被永久抹掉。
     *     而且它删完之后什么都不打印，看起来「一切正常」。2026-10-16 统一到共享快照。）
     */
    const rr = S.restoreRegistry(HOST_NAME, regSnap.value)
    console.log(`清理：注册表实际值 = ${rr.actual || '(键不存在)'}`)
    rec(
      '清理：注册表恢复到真原值',
      rr.ok === true && regSnap.polluted !== true,
      `${rr.actual || '(键不存在)'} vs ${rr.want || '(无)'}${regSnap.polluted ? ' ⚠ 备份里也是隔离值，原值可能早已被覆盖' : ''}`,
    )
    const removed = D.removeProfile(path.join(D.PROFILE_ROOT, PROFILE))
    bridge.stop()
    for (const f of ['p2-manifest.json', 'p2-host.cmd']) {
      try {
        fs.rmSync(path.join(DATA, f), { force: true })
      } catch {
        /* 忽略 */
      }
    }
    server.close()
    for (const id of created) {
      try {
        session.remove(id)
      } catch {
        /* 忽略 */
      }
    }
    fs.rmSync(STAGE, { recursive: true, force: true })
    console.log(`  清理：profile 删掉=${removed}`)
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.log('ERR', e && e.stack)
  process.exit(1)
})
