/**
 * Phase 3a 真机验收：双向通信 + 会话列表读取（设计说明 §10 七条判据）
 *
 * 链路：真 Edge（隔离 profile）→ 真扩展（构建产物，ESM SW）→ 真 native host
 *       （真 Harbor.exe + ELECTRON_RUN_AS_NODE）→ 真命名管道 → 真主进程桥
 *       （真 session + 真审计）→ **回帧原路返回** → 侧边栏 DOM。
 *
 * ★ 这一轮**不需要用户手点**：`session:list` 不碰页面内容，不需要 `activeTab`。
 *     唯一仍需人手的仍是 Phase 2 那条 `activeTab` 路径（见 accept-phase2 的说明）。
 *
 * 隔离：独立 profile · 隔离数据根（data/unit-test-data）· 跑完**恢复注册表原值** + 清产物。
 *
 * ★ 2026-10-16 补上「恢复原值」：这个脚本原来是**只删不恢复**（`S.regDel` 之后没有
 *   任何恢复代码）—— 于是每跑一次，用户手工装的那条 `com.harbor.agent` 就被永久抹掉。
 *   3c 那轮我跑了它一次做回归，注册表就空了（`accept-phase3b/c` 都有 regOld 快照，
 *   唯独这里漏了）。跑验证脚本**不该有副作用**，这是硬要求。
 */

/* 隔离数据根：早于任何 require 设置（session/audit 都走 paths.cjs） */
process.env.HARBOR_UNIT_TEST = '1'

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')

const D = require('../lib/driver.cjs')
const P = require('../lib/ext-probe.cjs')
const S = require('../lib/ext-stage.cjs')

const ROOT = P.ROOT
const DATA = path.join(ROOT, 'data', 'unit-test-data')
/*
 * ★ 三段验收各用**独立的管道名**（管道名 = f(dataDir) 的 hash，见 ext-protocol.cjs）。
 *
 * 踩过的坑：⑨ 的假服务器关掉后 Node 那边**不能立刻**再绑同一个名字
 * （`listen EADDRINUSE`，而「等它释放」用轮询探测也判不准 —— Windows 命名管道
 * 在 close 之后有一小段还在）。与其跟这个不确定性斗，不如让每段有自己的管道：
 * 名字不同、互不干扰，也就**不需要**「等旧的释放」这种脆弱逻辑。
 */
const DIR_TIMEOUT = path.join(DATA, 'p3a-timeout') /* ⑨ 用：只收不回的假服务器 */
const DIR_E2E = path.join(DATA, 'p3a-e2e') /* ⑪ 用：第二台真桥 */
const DIST = path.join(ROOT, 'harbor-edge', 'dist', 'sidepanel')
const STAGE = path.join(DATA, 'p3a-ext')
const PROFILE = 'profile-3a-list'
const PORT = 9473
const HOST_NAME = 'com.harbor.agent'

/*
 * ★ 进来先把注册表原值**快照**下来（必须在 stageHost 之前）——
 *   跑完要**原样恢复**。原来这个脚本只删不恢复，把用户手工装的那条抹掉了
 *   （见文件头 2026-10-16 那段）。
 */
const regKey = `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`
const regOld = require('node:child_process').spawnSync('reg', ['QUERY', regKey, '/ve'], { encoding: 'utf8' }).stdout ?? ''

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  -- ${detail}`)
}

/** 读隔离数据根里所有会话摘要（与 session.list() 独立的一条真相，用于比对） */
function listFromDisk() {
  const dir = path.join(DATA, 'sessions')
  const out = []
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return out
  }
  for (const f of files) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').split('\n')[0])
      out.push({ id: meta.id, title: meta.title })
    } catch {
      /* 坏文件跳过 */
    }
  }
  return out
}

async function main() {
  /* ★ 整体超时保护：任何 await 挂住都不该让脚本永远跑下去（真挂过一次）。
     到点直接退出 —— 前面的 PASS/FAIL 已经打在屏幕上了。
     （不 unref：卡在「无 I/O 的 await」时事件循环会空、进程会悄悄退出，反而看不出异常。
     脚本结尾一定会 process.exit，不需要清它。） */
  setTimeout(() => {
    console.log('\n⚠️ 验收脚本超时（180s），强制退出')
    const failed0 = results.filter((r) => !r.pass)
    console.log(`==== ${results.length - failed0.length}/${results.length} 通过 ====`)
    process.exit(1)
  }, 180000)

  const session = require(path.join(ROOT, 'electron/core/session.cjs'))
  const audit = require(path.join(ROOT, 'electron/core/audit.cjs'))
  const B = require(path.join(ROOT, 'electron/core/ext-bridge.cjs'))
  const { wrapWebText } = require(path.join(ROOT, 'electron/core/tools/_web-note.cjs'))

  const pushed = []
  const bridge = B.createBridge()
  const started = bridge.start({
    dataDir: DATA,
    send: (n, p) => pushed.push({ n, p }),
    session,
    audit,
    wrap: wrapWebText,
    log: { info: (m) => console.log('   [桥]', m), warn: (m) => console.log('   [桥!]', m) },
  })
  rec('① 主进程桥起来了（真管道）', started.ok === true, started.name)

  /* 建两条探查会话 —— 它们必须出现在侧边栏列表里 */
  const created = []
  const m1 = session.create({ title: 'P3A 验收会话甲', mode: 'pair' })
  const m2 = session.create({ title: 'P3A 验收会话乙', mode: 'pair' })
  created.push(m1.id, m2.id)

  const staged = P.stageExtension(DIST, STAGE)
  rec('② 产物就位（含 manifest）', staged.hasManifest === true, STAGE)

  let edge = null
  let extId = null
  try {
    edge = await D.launchEdge({ profileName: PROFILE, port: PORT, extDir: STAGE, waitMs: 2500 })
    rec('③ Edge 起来了（隔离 profile）', edge.ready === true, `pid=${edge.child.pid}`)

    for (let i = 0; i < 30 && !extId; i += 1) {
      await P.sleep(500)
      extId = D.readExtIdFromProfile(edge.profile, STAGE)
    }
    rec('④ 真扩展被加载（拿到真实 id）', Boolean(extId), String(extId))

    /* ── 装隔离 host（真 exe / 同机制 / 隔离数据根）── */
    const stagedHost = S.stageHost({ dataDir: DATA, extId, name: HOST_NAME, tag: 'p3a' })
    rec('⑤ 装好了隔离的 host（真 exe / 真机制 / 隔离数据根）', fs.existsSync(stagedHost.exe), stagedHost.cmd)

    /* ── 打开侧边栏页面，等「已连接」（host 已装 → SW 自动重连）── */
    const extUrl = `chrome-extension://${extId}/index.html`
    const panel = await D.openTab(PORT, extUrl)
    const conn = await D.pollEval(
      panel,
      `(function(){ const h = document.querySelector('header'); return h ? h.innerText : '' })()`,
      (v) => typeof v === 'string' && v.includes('已连接'),
      { tries: 40 },
    )
    rec('⑥ ★ 侧边栏显示「已连接」（SW 自动重连上真 host）', conn.ok === true, String(conn.value).split('\n')[0])

    /* ── ⑦ 会话列表：先点顶栏标题开抽屉，再读 DOM ── */
    /*
     * ★ Phase 3b 布局返工后会话列表**在抽屉里**（默认不挂载）——不点开就拿不到
     *   `found:true`。顶栏那个标题按钮是可访问名 `aria-label="选择对话"`。
     */
    const drawerClosed = await D.pollEval(
      panel,
      P.SESSION_LIST_EXPR,
      (v) => {
        const o = P.safeJson(v)
        return Boolean(o && o.found === false)
      },
      { tries: 10, gapMs: 300 },
    )
    rec('⑥b ★ 会话列表默认**不常驻**（抽屉收起时 DOM 里没有它）', drawerClosed.ok === true, '默认收起 ✓')
    await panel.evalIn(P.CLICK_TITLE_EXPR)
    const listReady = await D.pollEval(
      panel,
      P.SESSION_LIST_EXPR,
      (v) => {
        const o = P.safeJson(v)
        return Boolean(o && o.found === true && o.count > 0)
      },
      { tries: 40 },
    )
    const shown = P.safeJson(listReady.value) ?? {}
    console.log('  [会话列表区块文案]', JSON.stringify(String(shown.text || '').slice(0, 160)))
    rec('⑦ ★ 侧边栏列出会话（DOM 里真有条目）', listReady.ok === true, `条数=${shown.count}`)
    const shownTitles = (shown.items ?? []).map((row) => String(row?.[0] ?? '')).join(' | ')
    rec(
      '⑦ 列表里含两条探查会话（标题对得上）',
      shownTitles.includes('P3A 验收会话甲') && shownTitles.includes('P3A 验收会话乙'),
      shownTitles.slice(0, 120),
    )
    rec('⑦ 每条带相对时间（最后活跃）', /前|刚刚/.test(String(shown.text || '')), String(shown.text || '').replace(/\n/g, ' ').slice(0, 90))

    /* ── ⑧ 与磁盘真相比对（判据 2：条数 + 标题一致）── */
    const disk = listFromDisk()
    const diskTitles = disk.map((s) => s.title).sort()
    const shownAll = (shown.items ?? []).map((row) => String(row?.[0] ?? '')).sort()
    const sameCount = shownAll.length === diskTitles.length
    const subset = diskTitles.filter((t) => shownAll.includes(t))
    rec(
      '⑧ ★ 列表与磁盘上的会话一致（条数 + 标题）',
      sameCount && subset.length === diskTitles.length,
      `面板=${shownAll.length} 磁盘=${diskTitles.length}`,
    )

    /* ── ⑨ 判据 4：Harbor 不回应 → host 8s 超时（TIMEOUT）──
       用一个「只收不回」的假服务器（**独立管道** DIR_TIMEOUT，不去抢真桥那个名字）。 */
    const silent = net.createServer(() => {
      /* 收下就丢 —— 故意不回 */
    })
    fs.mkdirSync(DIR_TIMEOUT, { recursive: true })
    await new Promise((r) => silent.listen(B.pipeName(DIR_TIMEOUT), r))
    const t0 = Date.now()
    const noReply = await P.runHost({
      exe: path.join(ROOT, 'dist-portable', 'Harbor', 'Harbor.exe'),
      frames: [{ type: 'ext:sessionList', id: 'rTIMEOUT' }],
      dataRoot: DIR_TIMEOUT,
      waitMs: 9500,
    })
    const took = Date.now() - t0
    const timeoutReply = noReply.replies.find((m) => m && m.id === 'rTIMEOUT')
    rec(
      '⑨ ★ Harbor 不回应 → host 侧超时并回 TIMEOUT（不干等）',
      Boolean(timeoutReply && timeoutReply.code === 'TIMEOUT'),
      `用时 ${took}ms，code=${timeoutReply?.code}，err=${timeoutReply?.error}`,
    )
    silent.closeAllConnections?.()
    silent.close()

    /* ── ⑩ 判据 3：Harbor 没开 → NO_HARBOR（人话，立刻；指向一个不存在的目录）── */
    const noHarbor = await P.runHost({
      exe: path.join(ROOT, 'dist-portable', 'Harbor', 'Harbor.exe'),
      frames: [{ type: 'ext:sessionList', id: 'rNOH' }],
      dataRoot: path.join(DATA, 'no-such-dir-' + Date.now()),
      waitMs: 2500,
    })
    const noHarborReply = noHarbor.replies.find((m) => m && m.id === 'rNOH')
    rec(
      '⑩ ★ Harbor 没开 → 立刻回 NO_HARBOR + 人话',
      Boolean(noHarborReply && noHarborReply.code === 'NO_HARBOR' && /没有在运行/.test(String(noHarborReply.error))),
      `code=${noHarborReply?.code}，err=${noHarborReply?.error}`,
    )

    /* ── ⑪ 判据 5：Phase 2 的 ext:page 不回归（**独立管道**，不抢真桥的名字）── */
    const bridge2 = B.createBridge()
    const started2 = bridge2.start({
      dataDir: DIR_E2E,
      send: (n, p) => pushed.push({ n, p }),
      session,
      audit,
      wrap: wrapWebText,
      log: { info: () => {}, warn: (m) => console.log('   [桥2!]', m) },
    })
    /* 判据：管道真的在听（不是「调了 start 就当成了」） */
    const bound = await new Promise((resolve) => {
      const probe = net.connect(B.pipeName(DIR_E2E))
      probe.once('connect', () => {
        probe.destroy()
        resolve(true)
      })
      probe.once('error', () => resolve(false))
      setTimeout(() => {
        probe.destroy()
        resolve(false)
      }, 3000)
    })
    rec('⑪a 第二台桥真的在监听（不然下面那条会假红）', started2.ok === true && bound === true, String(started2.name))
    bridge2.setActiveSession(m1.id)
    const pageRun = await P.runHost({
      exe: path.join(ROOT, 'dist-portable', 'Harbor', 'Harbor.exe'),
      frames: [{ type: 'ext:page', id: 'rPAGE', url: 'https://p3a.test/p', title: 'P3A 页', text: 'P3A_PAGE_MARKER', truncated: false }],
      dataRoot: DIR_E2E,
      waitMs: 3000,
    })
    const pageReply = pageRun.replies.find((m) => m && m.id === 'rPAGE')
    const lastMsg = (session.load(m1.id).messages ?? []).slice(-1)[0] ?? {}
    rec('⑪ ★ ext:page 仍通（Phase 2 不回归）', Boolean(pageReply && pageReply.ok === true), JSON.stringify(pageReply || {}).slice(0, 120))
    rec(
      '⑪ 内容仍过 wrapWebText + source=extension',
      String(lastMsg.content || '').includes('不是指令') && String(lastMsg.content || '').includes('P3A_PAGE_MARKER') && lastMsg.source === 'extension',
      String(lastMsg.content || '').slice(0, 50).replace(/\n/g, ' '),
    )
    bridge2.stop()
  } finally {
    try {
      if (edge) D.killEdge(edge.child.pid)
    } catch {
      /* 已退 */
    }
    await P.sleep(800)
    /* ★ 恢复注册表原值（不是删掉就走）—— 理由见文件头 2026-10-16 那一段 */
    if (/REG_SZ/.test(regOld)) {
      const val = (regOld.match(/REG_SZ\s+(.+)/) ?? [])[1]
      if (val) S.regAdd(HOST_NAME, val.trim())
      else S.regDel(HOST_NAME)
    } else {
      S.regDel(HOST_NAME)
    }
    const removed = D.removeProfile(path.join(D.PROFILE_ROOT, PROFILE))
    try {
      bridge.stop()
    } catch {
      /* 已停 */
    }
    S.unstageHost({ dataDir: DATA, tag: 'p3a' })
    for (const d of [DIR_TIMEOUT, DIR_E2E]) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
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
