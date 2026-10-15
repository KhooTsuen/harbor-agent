/**
 * 自检 / 扩展通道那一层（Phase 3a 起）：协议 + 分派表 + host 循环
 *
 * 156 守「页面内容落会话」那条链（Phase 2 语义）；本组守**双向**那一层：
 * ① 协议层（`ext-protocol.cjs`）的报文构造与判据（`request`/`reply`/`failure`/`push`、
 *    「应答 vs 推送」靠**有没有 id**、错误码）；② 分派表（`ext-ops.cjs`，真 session +
 *    假 audit/send；★ 抛异常必须变 `INTERNAL`）；③ host 循环（`ext-host-loop.cjs`，
 *    **假 client** 驱动）；④ 接线（白名单、`runInteractive`、`main.cjs` 仍 0 改动）。
 *
 * ⚠️ 真管道往返不在自检里 —— 属于 `harbor-edge/tools/accept-phase3a.cjs`（真机验收）。
 */

import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

export async function run() {
  const P = require(join(ROOT, 'electron/core/ext-protocol.cjs'))
  const O = require(join(ROOT, 'electron/core/ext-ops.cjs'))
  const L = require(join(ROOT, 'electron/core/ext-host-loop.cjs'))
  const H = require(join(ROOT, 'electron/native-host.cjs'))
  const session = require(join(ROOT, 'electron/core/session.cjs'))
  const { wrapWebText } = require(join(ROOT, 'electron/core/tools/_web-note.cjs'))

  /* ── ① 协议层：报文构造与判据 ── */
  group('扩展通道 · 协议层（报文 / 判据 / 错误码）')

  const req = P.request({ id: 'h-1', kind: 'session:list', payload: { limit: 5 }, token: 'tok' })
  check('★ 请求带 v / id / kind / payload / token', req.v === P.V && req.id === 'h-1' && req.kind === 'session:list' && req.token === 'tok', JSON.stringify(req))
  check('★ 请求少了参数也不抛（构造函数的解构有默认值）', typeof P.request().id === 'string' && typeof P.request().kind === 'string')

  const rep = P.reply({ id: 'h-1', kind: 'session:list', payload: { sessions: [] } })
  check('★ 应答 ok=true 且带 payload', rep.ok === true && rep.id === 'h-1')
  check('★ 应答**是**协议帧、**不是**推送', P.isProtocolFrame(rep) === true && P.isReply(rep) === true && P.isPush(rep) === false)

  const fail = P.failure({ id: 'h-2', kind: 'x', code: P.ERR.UNKNOWN_KIND, message: 'm' })
  check('★ 错误应答 ok=false + error{code,message}', fail.ok === false && fail.error.code === 'UNKNOWN_KIND')
  check('★ 错误码缺省是 INTERNAL（不会给出 undefined）', P.failure({ id: 'h', kind: 'k' }).error.code === P.ERR.INTERNAL)

  const pushed = P.push({ kind: 'chat:delta', payload: { text: 'x' } })
  check('★ 推送**没有 id**（这就是与应答的区别）', pushed.push === true && pushed.id === undefined, JSON.stringify(pushed))
  check('★ 推送能被 isPush 认出来、且不算协议帧', P.isPush(pushed) === true && P.isProtocolFrame(pushed) === false)

  /* ★ 判据是「有 id」而非「有 id 且有 kind」—— 缺 kind 时还得回 UNKNOWN_KIND 帧 */
  check('★ 有 id 无 kind 也算协议帧（否则 host 解不开那条应答）', P.isProtocolFrame({ id: 'h-3' }) === true)
  check('★ 裸 JSON（无 id）不算协议帧 → 走兼容路径', P.isProtocolFrame({ kind: 'ext:page', url: 'u' }) === false)

  const codes = Object.values(P.ERR)
  /* ★ 不判**总数**（会随阶段涨 —— 硬约束 8）；只判「这些码必须在」 */
check(
  '★ 错误码含 3a+3b 全部（两侧共用）',
  ['NO_HARBOR', 'TIMEOUT', 'BAD_TOKEN', 'BAD_FRAME', 'UNKNOWN_KIND', 'INTERNAL', 'TOO_LARGE', 'SESSION_BUSY', 'NO_SESSION', 'NO_WINDOW'].every((c) => codes.includes(c)),
  codes.join(','),
)
  check('★ 帧上限：Edge 侧 1MB、管道侧 2MB（管道更宽，因 JSON 转义会膨胀）', P.MAX_FRAME === 1024 * 1024 && P.MAX_PIPE_FRAME === 2 * 1024 * 1024)
  check('★ host 超时是 8s（比扩展侧 15s 短 —— 让 host 先超时、回带 code 的人话）', P.HOST_TIMEOUT_MS === 8000)

  /* 编解码实现与 154 是**同一份**（不是各写一套） */
  check('★ 帧编解码只有一处实现（native-host 转出的与协议层是同一个函数）', H.encodeFrame === P.encodeFrame && H.decodeFrames === P.decodeFrames)

  /* ── ② 分派表（真 session，隔离数据根）── */
  group('扩展通道 · 分派表 ext-ops（落会话 / 列表 / 错误）')

  const audited = []
  const sent = []
  let active = ''
  let wrapperCalled = 0
  const ops = O.createOps({
    session,
    audit: { record: (e) => audited.push(e) },
    wrap: (input) => {
      wrapperCalled += 1
      return wrapWebText(input)
    },
    send: (name, payload) => sent.push({ name, payload }),
    getActiveSession: () => active,
  })

  const made = []
  try {
    /* ★ 只判「这几个必须在」（不判全等 —— kind 会随阶段涨） */
check(
  '★ 分派表认 3a 的 kind（ext:page / session:list）',
  ['ext:page', 'session:list'].every((k) => ops.kinds().includes(k)),
  ops.kinds().join(','),
)

    const meta = session.create({ title: '自检：3a 当前会话', mode: 'pair' })
    made.push(meta.id)
    active = meta.id

    const r = ops.handle('ext:page', { url: 'https://a.test/p', title: '页', text: 'MARK3A' })
    check('★ ext:page 落进「当前会话」（没另建）', r.ok === true && r.data.created === false && r.data.sessionId === meta.id)
    check('★ 包装真的被调了（安全职责，不能被绕过）', wrapperCalled === 1, String(wrapperCalled))
    const last = (session.load(meta.id).messages ?? []).slice(-1)[0] ?? {}
    check('★ 内容过了包装 + 标了 source=extension', String(last.content).includes('不是指令') && last.source === 'extension')
    check('★ 审计记了 source/url/chars', audited.some((a) => a.extras?.source === 'extension' && a.extras?.url === 'https://a.test/p'))
    check('★ 推了一条 ext:page 给渲染层', sent.some((s) => s.name === 'ext:page'))

    /* 没有当前会话 → 兜底新建（内容不丢） */
    active = ''
    const before = session.list().length
    const r2 = ops.handle('ext:page', { url: 'u', title: '兜底', text: 'b' })
    check('★ 没有当前会话时新建兜底会话', r2.ok === true && r2.data.created === true && session.list().length === before + 1)
    for (const s of session.list()) {
      if (/^浏览器：/.test(s.title)) made.push(s.id)
    }

    /* 报了一条非法 id → 也兜底（不能抛穿） */
    active = 'sess_不存在'
    const r3 = ops.handle('ext:page', { url: 'u', title: 'x', text: 'y' })
    check('★ 报来的会话不存在/非法 → 兜底新建（不抛）', r3.ok === true && r3.data.created === true)
    for (const s of session.list()) {
      if (/^浏览器：/.test(s.title)) made.push(s.id)
    }

    const list = ops.handle('session:list')
    check('★ session:list 返回数组', list.ok === true && Array.isArray(list.data.sessions))
    const first = list.data.sessions[0] ?? {}
    check(
      '★ 列表字段是 session.list() 的原样（不另造形状）',
      ['id', 'title', 'mode', 'model', 'workdir', 'createdAt', 'updatedAt', 'messageCount'].every((k) => k in first),
      JSON.stringify(Object.keys(first)),
    )

    const bad = ops.handle('nope:nope')
    check('★ 未知 kind → UNKNOWN_KIND（不抛）', bad.ok === false && bad.error.code === 'UNKNOWN_KIND')
    const empty = ops.handle('')
    check('★ 空 kind → 也是 UNKNOWN_KIND（不炸）', empty.ok === false && empty.error.code === 'UNKNOWN_KIND')

    /*
     * ★★ 这条最要紧：**处理函数抛异常不能把管道服务器带倒**。
     * 用一个会在 list() 上抛的假 session —— 模拟「磁盘/数据坏了」。
     */
    const boom = O.createOps({
      session: { list: () => { throw new Error('磁盘炸了') } },
      audit: { record: () => {} },
      wrap: wrapWebText,
      send: () => {},
    })
    const caught = boom.handle('session:list')
    check(
      '★★ 处理函数抛异常 → 变成 INTERNAL（管道服务器不会倒）',
      caught.ok === false && caught.error.code === 'INTERNAL' && /磁盘炸了/.test(caught.error.message),
      JSON.stringify(caught),
    )
  } finally {
    for (const id of made) {
      try {
        session.remove(id)
      } catch {
        /* 清理失败不影响断言 */
      }
    }
  }

  /* ── ③ host 循环：分派映射（假 client）── */
  group('扩展通道 · host 循环 dispatch（假 client 驱动）')

  const calls = []
  const fakeClient = {
    request: async (kind, payload) => {
      calls.push({ kind, payload })
      if (kind === 'session:list') return { ok: true, payload: { sessions: [{ id: 's1', title: 't' }] } }
      if (kind === 'ext:page') return { ok: true, payload: { sessionId: 's9', chars: 3 } }
      return { ok: false, error: { code: 'TIMEOUT', message: '慢' } }
    },
  }
  const dispatch = L.createDispatcher(fakeClient)

  const pong = await dispatch({ ping: 1 })
  check('★ ping 不碰管道（同步回 pong）', pong.pong === 1 && pong.echo.ping === 1 && calls.length === 0)

  const listMsg = await dispatch({ type: 'ext:sessionList', id: 'rA' })
  check('★ ext:sessionList → ext:sessionList.result（带原 id）', listMsg.type === 'ext:sessionList.result' && listMsg.id === 'rA' && listMsg.ok === true, JSON.stringify(listMsg))
  check('★ 会话列表原样透传', listMsg.sessions?.[0]?.id === 's1')
  check('★ 走的是 session:list 这个 kind', calls.some((c) => c.kind === 'session:list'))

  const pageMsg = await dispatch({ type: 'ext:page', id: 'rB', url: 'u', title: 't', text: 'abc' })
  check('★ ext:page → ext:page.result（形状与 Phase 2 一致）', pageMsg.type === 'ext:page.result' && pageMsg.ok === true && pageMsg.chars === 3 && pageMsg.id === 'rB', JSON.stringify(pageMsg))

  const badType = await dispatch({ type: 'nope:nope', id: 'rC' })
  check('★ 不认识的 type → 回 error（不抛、不静默）', typeof badType.error === 'string')
  const nul = await dispatch(null)
  check('★ null 消息 → 也回一条（不抛）', typeof nul.error === 'string')

  /* 主进程回错误时，dispatch 必须把 host 侧的 code/message 转给扩展（不能吞掉原因） */
  const failClient = { request: async () => ({ ok: false, error: { code: 'TIMEOUT', message: 'Harbor 没有响应（超时）' } }) }
  const failDispatch = L.createDispatcher(failClient)
  const failMsg = await failDispatch({ type: 'ext:sessionList', id: 'rD' })
  check(
    '★ 主进程回错误 → 扩展拿到人话 + code（原因不被吞）',
    failMsg.ok === false && failMsg.code === 'TIMEOUT' && /超时/.test(String(failMsg.error)),
    JSON.stringify(failMsg),
  )
  const failPage = await failDispatch({ type: 'ext:page', id: 'rE', text: 'abc' })
  check(
    '★ ext:page 失败时也是人话 + code（不是静默成功）',
    failPage.ok === false && failPage.code === 'TIMEOUT' && failPage.chars === 3,
    JSON.stringify(failPage),
  )

  /* ── ④ 接线 ── */
  group('扩展通道 · 接线（3a 真的接上了）')

  const hostSrc = readFileSync(join(ROOT, 'electron/native-host.cjs'), 'utf8')
  const loopSrc = readFileSync(join(ROOT, 'electron/core/ext-host-loop.cjs'), 'utf8')
  const mainSrc = readFileSync(join(ROOT, 'electron/main.cjs'), 'utf8')
  /* ★ 只扫**代码**（去块注释）：注释里提到旧模块名是对的，代码里真用才是问题 */
  const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')

  check('★ native-host 代码里不再 require 已删的 ext-forward', !/ext-forward\.cjs/.test(codeOnly(hostSrc)))
  check('★ native-host 用上了 ext-client（兼容形态的同步写）', /ext-client\.cjs/.test(hostSrc))
  check('★ require.main === module → 进 runInteractive（事件驱动，不是老 run）', /require\.main === module[\s\S]{0,200}runInteractive/.test(hostSrc))
  check(
    '★ 白名单里有 3a 的三个新模块（host 进程要能 require 它们）',
    ['core/ext-protocol.cjs', 'core/ext-client.cjs', 'core/ext-host-loop.cjs'].every((m) => H.SAFE_MODULES.includes(m)),
    H.SAFE_MODULES.filter((m) => m.startsWith('core/ext')).join(','),
  )
  check('★ 白名单里没有已删的 ext-forward', !H.SAFE_MODULES.includes('core/ext-forward.cjs'))
  check(
    '★ host 循环的代码里不自己改道 stdout（保命线只在 native-host 一处实现）',
    /console\.log = \(\.\.\.args\) => console\.error\(\.\.\.args\)/.test(hostSrc) && !/console\.log = /.test(codeOnly(loopSrc)),
  )
  check('★ host 循环的 stdin 收帧后回帧走 writeSync(1)（stdout 是协议通道）', /fs\.writeSync\(1,/.test(loopSrc))
  check('★ stdin EOF → 干净退出（不留僵尸 host）', /stdin\.on\('end'/.test(loopSrc) && /process\.exit\(0\)/.test(loopSrc))
  check('★ main.cjs 仍未被改（3a 的装配不在那儿 —— 裁决 A3）', !/ext-bridge|ext-protocol|ext-client|ext-host-loop/.test(mainSrc))

  /* ── ⑤ 裸 JSON 兜底：**真管道**跑一遍（判据 6）── */
  group('扩展通道 · 裸 JSON 兜底（真管道，旧 host → 新主进程）')

  /*
   * 必须真跑：判据是「fatal + 首字节 `{`」——纯函数测不出来。
   * 场景：用户 Edge 开着时升级 Harbor，旧 host 还活着，发的就是裸 JSON。
   */
  const net = require('node:net')
  const tmpDir2 = join(ROOT, 'data', 'selftest-data', 'ext-bridge-legacy')
  const B2 = require(join(ROOT, 'electron/core/ext-bridge.cjs'))
  const bridge2 = B2.createBridge()
  const made2 = []
  let sentBack = null
  try {
    bridge2.start({
      dataDir: tmpDir2,
      send: () => {},
      session,
      audit: { record: () => {} },
      wrap: wrapWebText,
      log: { info: () => {}, warn: () => {} },
    })
    const target = session.create({ title: '自检：裸 JSON 兜底', mode: 'pair' })
    made2.push(target.id)
    bridge2.setActiveSession(target.id)

    /* 真 socket，**裸 JSON**（没有长度前缀 —— 旧 host 就是这么发的），写完就关连接 */
    await new Promise((resolve) => {
      const s = net.connect(B2.pipeName(tmpDir2), () => {
        s.end(
          Buffer.from(
            JSON.stringify({ token: B2.readToken(tmpDir2), kind: 'ext:page', url: 'https://legacy.test/o', title: '旧 host', text: 'LEGACY_MARKER', truncated: false }),
            'utf8',
          ),
        )
      })
      s.on('close', () => resolve(true))
      s.on('error', () => resolve(false))
      setTimeout(() => resolve(false), 4000)
    })

    const last = (session.load(target.id).messages ?? []).slice(-1)[0] ?? {}
    check('★ 裸 JSON（无 id、无长度前缀）被收下并落进会话', String(last.content || '').includes('LEGACY_MARKER'), String(last.content || '').slice(0, 60).replace(/\n/g, ' '))
    check('★ 内容过了包装（兜底路径也走同一份 wrapWebText）', String(last.content || '').includes('不是指令'))
    /*
     * ⚠️ **不验「回了什么」** —— 旧 host 是「写完就关连接」，它**读不到回复**
     *    （Phase 2 就记录过这个事实：`delivered` 只表示字节进了管道）。
     *    真正该验的是：这条连接关掉之后**桥还健康**（兜底路径没把服务器带坏）。
     */
    const okAfterLegacy = await new Promise((resolve) => {
      const s = net.connect(B2.pipeName(tmpDir2), () => {
        s.end(Buffer.from(JSON.stringify({ token: B2.readToken(tmpDir2), kind: 'ext:page', url: 'u2', title: 't2', text: 'LEGACY_SECOND', truncated: false }), 'utf8'))
      })
      s.on('close', () => resolve(true))
      s.on('error', () => resolve(false))
      setTimeout(() => resolve(false), 4000)
    })
    const count = (session.load(target.id).messages ?? []).filter((m) => String(m.content || '').includes('LEGACY_SECOND')).length
    check('★ 旧式连接关掉后桥仍健康（第二条裸 JSON 照常落盘）', okAfterLegacy === true && count === 1, `第二条落盘=${count}`)
  } finally {
    bridge2.stop()
    for (const id of made2) {
      try {
        session.remove(id)
      } catch {
        /* 忽略 */
      }
    }
  }
}
