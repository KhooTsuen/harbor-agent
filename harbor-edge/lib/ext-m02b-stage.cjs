/**
 * M02-B 验收的**准备件**：起服务器 / 桥 / 隔离 Edge / 真侧栏，以及读面板与读会话的小工具。
 *
 * 从 `tools/accept-m02b.cjs` 拆出来 —— 那边 308 行 > 300 红线，而**判据本身一条都不能删**。
 * 拆法按职责：这里全是「怎么把环境搭起来」，那边只剩「验什么」。
 *
 * ★ 真侧栏用 `lib/ext-panel.cjs`（全仓库唯一一处实现）；副本放宽 `host_permissions`
 *   只为排除权限噪声（CDP 点不到工具栏 → 拿不到 activeTab），产品 manifest 由
 *   `stageExtensionWithHostPerms` 复核没被改。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const S = require('./ext-stage.cjs')
const SP = require('./ext-stage-perms.cjs')
const EP = require('./ext-panel.cjs')
const EPT = require('./ext-panel-trigger.cjs')

const ROOT = S.ROOT
const ISO = path.join(ROOT, 'data', 'unit-test-data')
const HOST_NAME = 'com.harbor.agent'
const PORT_EDGE = 9381
const PORT_PAGE = 8911
const PROFILE = 'profile-m02b'
const DIST = path.join(ROOT, 'harbor-edge', 'dist', 'sidepanel')
const STAGE = path.join(ISO, 'm02b-ext')

const PAGE_HTML = '<!doctype html><title>M02B 验收页</title><h1>M02B 验收页</h1><p>MARKER_M02B_BODY</p>'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 在侧栏里求值拿回对象（evalIn 只回 value，自己编解码） */
async function inPanel(panel, expr) {
  const raw = await panel.evalIn(`JSON.stringify((()=>{try{return (${expr})}catch(e){return {__err:String(e&&e.message||e)}}})())`)
  try {
    return JSON.parse(String(raw || '{}'))
  } catch {
    return { __err: 'JSON 解析失败：' + String(raw).slice(0, 80) }
  }
}

/** 有没有某张卡（aria-label 是验收锚点） */
const hasCard = (label) => `!!document.querySelector('[aria-label="${label}"]')`

/** 某条会话里有几条消息含这个标记（读不出来给 -1，别当成 0 蒙过去） */
function countIn(sid, needle) {
  try {
    const L = require(path.join(ROOT, 'electron/core/session-io.cjs')).readLines(sid)
    return L.filter((l) => l.type === 'message' && String(l.content ?? '').includes(needle)).length
  } catch {
    return -1
  }
}

/**
 * 搭好整套环境并返回句柄。
 *
 * @param {(name: string, ok: boolean, detail?: unknown) => void} rec 记一条判据
 */
async function setup(rec) {
  const server = http.createServer((_q, r) => {
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    r.end(PAGE_HTML)
  })
  server.listen(PORT_PAGE, '127.0.0.1')

  process.env.HARBOR_UNIT_TEST = '1'
  const B = require(path.join(ROOT, 'electron/core/ext-bridge.cjs'))
  const CH = require(path.join(ROOT, 'electron/core/ext-chat.cjs'))
  const Proto = require(path.join(ROOT, 'electron/core/ext-protocol.cjs'))
  const session = require(path.join(ROOT, 'electron/core/session.cjs'))
  const D = require('./driver.cjs')

  const sess = session.create({ title: 'M02B 验收会话', mode: 'pair' })
  const bridge = B.createBridge()
  const sent = []
  const chatRelay = CH.createChatRelay({
    streams: new Map(),
    getMainWindow: () => ({}),
    send: (channel, payload) => sent.push({ channel, payload }),
    log: { info: () => {}, warn: () => {} },
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
  })
  rec('① 验收进程里的桥起来了（真管道）', started.ok === true, started.name)
  if (!started.ok) return { ok: false, server }

  const staged = SP.stageExtensionWithHostPerms(DIST, STAGE)
  rec('② 测试副本已就位（放宽 host_permissions）', staged.hasManifest === true, JSON.stringify(staged.hostPermissions))
  rec('②b ★ 产品 manifest 未被改动（仍无 host_permissions）', staged.productManifestUntouched === true)

  S.regDel(HOST_NAME)
  /* 每次清空隔离 profile：复用会留下上次 extId → 页面没有扩展接管（chrome.* 全 undefined） */
  D.removeProfile(path.join(D.PROFILE_ROOT, PROFILE))
  const edge = await D.launchEdge({ profileName: PROFILE, port: PORT_EDGE, extDir: staged.dir, waitMs: 2500 })
  rec('③ Edge 起来了（隔离 profile）', Boolean(edge && edge.child))

  let extId = ''
  for (let i = 0; i < 20 && !extId; i += 1) {
    await sleep(500)
    try {
      extId = D.readExtIdFromProfile(edge.profile, staged.dir)
    } catch {
      extId = ''
    }
  }
  rec('④ 真扩展被加载', Boolean(extId), extId)
  if (!extId) return { ok: false, server, D }

  S.stageHost({ dataDir: ISO, extId, name: HOST_NAME, tag: 'm02b' })

  /* 用户路径：先开页面，再点开真侧栏 */
  const pageTarget = await (
    await fetch(`http://127.0.0.1:${PORT_EDGE}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT_PAGE}/`)}`, { method: 'PUT' })
  ).json()
  await sleep(1800)
  rec('⑤ 用户页面已打开（用户路径第一步）', Boolean(pageTarget && pageTarget.id), `targetId=${pageTarget && pageTarget.id}`)

  const panel = await EP.openRealSidePanel({ port: PORT_EDGE, extId })
  rec('⑥ ★★★ 真侧栏已打开（不是新开扩展页）', panel.ok === true, panel.error || `innerWidth=${panel.innerWidth}`)
  if (!panel.ok) return { ok: false, server, D }

  const trig = await EPT.closeTriggerPages(PORT_EDGE, extId)
  await EP.bringToFront(PORT_EDGE, pageTarget.id)
  rec('⑥b 触发页已不在（侧栏仍在，不占标签位）', trig.remaining === 0, `关掉 ${trig.closed} · 剩 ${trig.remaining}`)

  let conn = 0
  for (let i = 0; i < 24 && conn === 0; i += 1) {
    try {
      conn = bridge.connectionCount()
    } catch {
      conn = 0
    }
    if (conn === 0) await sleep(500)
  }
  rec('⑦ 扩展连上 Harbor 管道', conn > 0, `连接数=${conn}`)

  /* service worker 句柄：读 chrome.storage 用（开关真正的落点） */
  const list = await (await fetch(`http://127.0.0.1:${PORT_EDGE}/json/list`)).json()
  const sw = list.find((t) => t.type === 'service_worker' && String(t.url || '').includes(extId))
  const readCtx = async () => {
    if (!sw) return null
    const c = await EP.connect(sw.webSocketDebuggerUrl)
    const v = await c.evalIn(`chrome.storage.local.get('harborContextEnabled').then(r=>JSON.stringify(r))`)
    c.close()
    try {
      return JSON.parse(String(v || '{}'))
    } catch {
      return null
    }
  }

  return { ok: true, server, D, session, sess, bridge, chatRelay, sent, Proto, panel, pageTarget, extId, readCtx }
}

/** 收尾：只杀本次隔离 profile 的 Edge（绝不按映像名杀，会误杀用户正开着的窗口） */
function teardown(env, regSnap) {
  const { spawnSync } = require('node:child_process')
  const out = spawnSync('wmic', ['process', 'where', "name='msedge.exe'", 'get', 'ProcessId,CommandLine'], { encoding: 'utf8' })
  const mine = String(out.stdout || '')
    .split('\n')
    .filter((l) => l.includes(PROFILE))
    .map((l) => (l.match(/(\d+)\s*$/) || [])[1])
    .filter(Boolean)
  for (const pid of mine) spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' })
  try {
    if (env?.session && env?.sess) env.session.remove(env.sess.id)
  } catch {
    /* 清不掉不影响判据 */
  }
  S.restoreRegistry(regSnap)
}

module.exports = { ROOT, HOST_NAME, PORT_EDGE, PAGE_HTML, sleep, inPanel, hasCard, countIn, setup, teardown, regSnapOf: () => S.snapshotRegistry(HOST_NAME) }
