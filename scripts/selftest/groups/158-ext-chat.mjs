/**
 * 自检 / 侧边栏发消息 + 流式回复（Phase 3b）
 *
 * 本组守的是 3b 那条新链：**侧边栏 → host → 主进程 → 渲染层 → 流分片回侧边栏**。
 * 五块：
 *
 *   ① **`ext-chat` 的三个业务分支**（纯函数式，注入假 streams / 假窗口）：
 *      没窗口 / 没会话 / 会话忙 → 各自的人话错误码；正常 → 推给渲染层。
 *   ② **SESSION_BUSY 判据**：按 `streams` 里的 `sessionId` 扫 —— 这条是 3b 唯一
 *      新增的判据，而它**必须**能从 `streams` 里读出来（所以 chat.cjs 补了那个字段）。
 *   ③ **流快照**：content 累加 / done 收尾 / 按 sessionId 查 / 只认更大的 seq。
 *   ④ **host 转发**：`chat:send` / `chat:resume` / `ext:sessionActive` 三个 type
 *      都要被 dispatcher 认（假 client 驱动，不起真进程）。
 *   ⑤ **接线**：`register-handlers` 真的把 relay 建起来 + `streams.set` 真的带了
 *      `sessionId` + `ext:send` 真的被渲染层订阅（少一处就「点了发送没反应」）。
 *
 * ★ 用**真 ext-chat / 真 ext-host-loop / 真 ext-ops**（不复制实现）——
 *   3a 那轮学到的：抄一份实现等于验了个假东西（硬约束 9）。
 */

import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

export async function run() {
  const CH = require(join(ROOT, 'electron/core/ext-chat.cjs'))
  const P = require(join(ROOT, 'electron/core/ext-protocol.cjs'))

  /* ── ① 业务分支（注入假东西，不起 Electron） ── */
  group('扩展对话 · ext-chat 的业务分支')

  /**
   * 造一个 relay。
   *
   * `win` = 主窗口在不在；`busy` = 哪些会话在跑；`selected` = **侧边栏**当前选中哪条
   * （Phase 3c 起 handleSend 用的是**侧边栏自己的选中**，不再跟随主窗口那条）。
   * `selected: ''` = 一条都没选（那时发消息会新建一条）。
   */
  function makeRelay({ win = {}, busy = [], selected = 'sess_a' } = {}) {
    const streams = new Map()
    busy.forEach((sid, i) => streams.set(`req_${i}`, { sessionId: sid }))
    const pushed = []
    const relay = CH.createChatRelay({
      streams,
      getMainWindow: () => win,
      send: (channel, payload) => pushed.push({ channel, payload }),
      log: { info: () => {}, warn: () => {} },
    })
    relay.setBridge({
      push: (kind, payload) => pushed.push({ push: { kind, payload } }),
      getActiveSession: () => selected,
    })
    /* 先「选中」一条（= 侧边栏点过它）→ 再清掉这一下的推送，免得混进下面的断言 */
    if (selected) relay.handleSelect({ sessionId: selected })
    pushed.length = 0
    return { relay, pushed, streams }
  }

  const r1 = makeRelay()
  const sent = r1.relay.handleSend({ text: '你好' })
  check('★ 正常：回 ok + sessionId（不给假 requestId）', sent.ok === true && sent.sessionId === 'sess_a', JSON.stringify(sent))
  check('★ 正常：推给渲染层的是 ext:send（那条路与用户手打同一条）', r1.pushed[0]?.channel === 'chat:event' && r1.pushed[0]?.payload?.type === CH.EXT_SEND, JSON.stringify(r1.pushed[0]?.payload))
  check('★ 正常：推的那条**不带 requestId**（真 id 由渲染层生成）', !('requestId' in (r1.pushed[0]?.payload ?? {})))

  const rEmpty = makeRelay()
  check('空消息被拒（不往下走）', rEmpty.relay.handleSend({ text: '   ' }).ok === false)

  const rNoWin = makeRelay({ win: null })
  const noWin = rNoWin.relay.handleSend({ text: 'hi' })
  check('★ C-α：主窗口不在 → NO_WINDOW（早拒，回人话）', noWin.ok === false && noWin.error.code === P.ERR.NO_WINDOW, noWin.error?.message)
  check('★ 窗口不在时不推给渲染层（推了也没人接）', rNoWin.pushed.length === 0)

  /* Phase 3c：**一条都没选**不再回 NO_SESSION —— 改成「请渲染层新建一条再发」 */
  const rNoSel = makeRelay({ selected: '' })
  const noSel = rNoSel.relay.handleSend({ text: 'hi' })
  check(
    '★ 3c：一条都没选 → 请渲染层新建一条（不再落进主窗口那条）',
    noSel.ok === true && noSel.created === true && noSel.sessionId === '',
    JSON.stringify(noSel),
  )
  check(
    '★ 3c：新建那条推给渲染层时带 newSession + 原文',
    rNoSel.pushed[0]?.channel === 'chat:event' &&
      rNoSel.pushed[0]?.payload?.newSession === true &&
      rNoSel.pushed[0]?.payload?.text === 'hi',
    JSON.stringify(rNoSel.pushed[0]?.payload),
  )

  /* ── ② SESSION_BUSY（3b 唯一新增的判据） ── */
  group('扩展对话 · SESSION_BUSY（按 streams 里的 sessionId 扫）')

  const rBusy = makeRelay({ busy: ['sess_a'] })
  const busy = rBusy.relay.handleSend({ text: 'hi' })
  check('★ 那条会话正在跑 → SESSION_BUSY + 人话（不静默排队）', busy.ok === false && busy.error.code === P.ERR.SESSION_BUSY, busy.error?.message)
  check('★ 人话里说清是「正在别处运行」', /正在别处运行/.test(String(busy.error?.message)))
  check('★ 忙的时候不推给渲染层（否则它会静默排队，用户以为消息丢了）', rBusy.pushed.length === 0)

  const rOther = makeRelay({ busy: ['sess_other'] })
  check('★ 别的会话在跑不算忙（只比 sessionId）', rOther.relay.handleSend({ text: 'hi' }).ok === true)

  /* ── ②b Phase 3c：选一条 / 新建一条 ── */
  group('扩展对话 · 选会话 / 新建（Phase 3c）')

  const rSel = makeRelay({ selected: '' })
  const sel = rSel.relay.handleSelect({ sessionId: 'sess_b' })
  check('★ 选中某条：回 ok + 记住它', sel.ok === true && rSel.relay.selectedOf() === 'sess_b')
  check(
    '★ 选中后推 session:selected 给扩展（侧边栏据此更新）',
    rSel.pushed.some((p) => p.push?.kind === P.KIND.SESSION_SELECTED),
  )
  check('★ 选中空 id → NO_SESSION（不静默）', rSel.relay.handleSelect({ sessionId: '' }).error?.code === P.ERR.NO_SESSION)

  const rSelSend = makeRelay({ selected: '' })
  rSelSend.relay.handleSelect({ sessionId: 'sess_b' })
  const selSent = rSelSend.relay.handleSend({ text: 'x' })
  check(
    '★ 选中之后发消息就发给**它**（不再新建）',
    selSent.ok === true && selSent.sessionId === 'sess_b' && selSent.created !== true,
    JSON.stringify(selSent),
  )
  /* 侧边栏带 sessionId 发消息时，以它为准（比主进程记的那份更新） */
  const rAsk = makeRelay({ selected: '' })
  const askSent = rAsk.relay.handleSend({ text: 'x', sessionId: 'sess_c' })
  check('★ 请求里带了 sessionId 就以它为准（并记住）', askSent.sessionId === 'sess_c' && rAsk.relay.selectedOf() === 'sess_c')

  const rNew = makeRelay()
  const created = rNew.relay.handleNew()
  check(
    '★ 点 ＋ → 请渲染层新建（推 ext:new）',
    created.ok === true && rNew.pushed.some((p) => p.channel === 'chat:event' && p.payload?.type === CH.EXT_NEW),
  )
  check('★ 窗口不在时点 ＋ → NO_WINDOW（早拒）', makeRelay({ win: null }).relay.handleNew().error?.code === P.ERR.NO_WINDOW)
  /* 渲染层把临时 id 换成真 id 后重报 → 侧边栏那套必须跟着学，否则下一条发丢 */
  const rLearn = makeRelay({ selected: '' })
  rLearn.relay.handleSend({ text: 'x' }) /* 触发新建 → 等回报 */
  rLearn.relay.noteActiveSession('sess_real')
  check('★ 渲染层回报真 id → 侧边栏跟着学（不然下一条发丢）', rLearn.relay.selectedOf() === 'sess_real')

  /* ── ③ 流快照 ── */
  group('扩展对话 · 流快照（上次流到哪）')

  const r3 = makeRelay()
  const rid = 'req_real'
  r3.streams.set(rid, { sessionId: 'sess_a' })
  r3.relay.onChatEvent({ requestId: rid, type: 'content', text: '甲' })
  r3.relay.onChatEvent({ requestId: rid, type: 'content', text: '乙' })
  const snap1 = r3.relay.snapshotOf(rid)
  check('★ content 累加进快照（增量拼全文）', snap1.text === '甲乙', snap1.text)
  check('★ 每片递增一个 seq（侧边栏据此丢旧片）', snap1.seq === 2, String(snap1.seq))
  check('★ sessionId 从 streams 反查出来（payload 里没有它）', snap1.sessionId === 'sess_a', snap1.sessionId)
  check('★ 分片推给扩展时 kind 是 chat:event', r3.pushed.some((p) => p.push?.kind === P.KIND.CHAT_EVENT))

  r3.relay.onChatEvent({ requestId: rid, type: 'done', content: '甲乙丙' })
  const snap2 = r3.relay.snapshotOf(rid)
  check('★ done：用事件里的完整正文兜底（合批没到齐也不丢）', snap2.text === '甲乙丙' && snap2.done === true, snap2.text)

  const resumed = r3.relay.handleResume({ sessionId: 'sess_a' })
  check('★ 续流：按 sessionId 回一份快照（seq + 全文）', resumed.ok === true && resumed.seq === snap2.seq && resumed.text === '甲乙丙', JSON.stringify(resumed).slice(0, 90))
  check('★ 续流：没跑过的会话回人话（不是空对象）', r3.relay.handleResume({ sessionId: 'sess_none' }).error?.message?.length > 0)
  check('★ 续流：不说会话就问当前打开的那条', (() => {
    const r = makeRelay()
    r.streams.set('r1', { sessionId: 'sess_a' })
    r.relay.onChatEvent({ requestId: 'r1', type: 'content', text: 'x' })
    return r.relay.handleResume({}).ok === true
  })())

  /* ── ④ host 侧转发（假 client 驱动） ── */
  group('扩展对话 · host 转发（chat:send / chat:resume / ext:sessionActive）')

  const HL = require(join(ROOT, 'electron/core/ext-host-loop.cjs'))
  const HLsrc = readFileSync(join(ROOT, 'electron/core/ext-host-loop.cjs'), 'utf8')
  check('★ host 认 chat:send（3b 新增）', /type === 'chat:send'/.test(HLsrc))
  check('★ host 认 chat:resume（3b 新增）', /type === 'chat:resume'/.test(HLsrc))
  check('★ host 认 ext:sessionActive（问当前打开哪条）', /type === 'ext:sessionActive'/.test(HLsrc))
  check('★ 续流按 sessionId 问（不是 requestId）', /\{\s*sessionId: String\(obj\.sessionId/.test(HLsrc))
  check('★ 不认识的 type 仍回人话（含新 kind 的清单）', /只认/.test(HLsrc) && HLsrc.includes('chat:send'))
  check('★ 推送原样转给扩展（3b 的流分片靠它）', /setPushHandler/.test(HLsrc))

  /* ── ⑤ 接线（少一处就「点了发送没反应」） ── */
  group('扩展对话 · 接线（3b 真的接上了）')

  const reg = readFileSync(join(ROOT, 'electron/register-handlers.cjs'), 'utf8')
  const chatSrc = readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8')
  const hookSrc = readFileSync(join(ROOT, 'src/hooks/useExtBridge.ts'), 'utf8')
  const preload = readFileSync(join(ROOT, 'electron/preload.cjs'), 'utf8')
  const nativeSrc = readFileSync(join(ROOT, 'harbor-edge/extension/lib/native.js'), 'utf8')
  /* M02-A：消息分派搬到了 lib/messages.js（SW 贴 300 红线）—— 「有没有某个入口」两处一起读 */
  const swSrc =
    readFileSync(join(ROOT, 'harbor-edge/extension/service-worker.js'), 'utf8') +
    readFileSync(join(ROOT, 'harbor-edge/extension/lib/messages.js'), 'utf8')
  const panelSrc = readFileSync(join(ROOT, 'harbor-edge/src/sidepanel/ChatPanel.tsx'), 'utf8')

  check('★ 装配处建了 relay（3b 的转发器）', /createChatRelay/.test(reg))
  check('★ relay 绑上了桥（push 与 activeSession 都从它取）', /chatRelay\.setBridge/.test(reg))
  check('★ relay 注进了桥的分派表（chat:send 才有人接）', /chat:\s*chatRelay/.test(reg))
  check(
    '★ chat.cjs 的 streams.set 带 sessionId（SESSION_BUSY 的判据靠它）',
    /streams\.set\(requestId, \{ controller, pause, sessionId \}\)/.test(chatSrc),
  )
  check('★ 旁听挂在 send 出口上（不新增参数、不改 chat.cjs 逻辑）', /channel === 'chat:event'/.test(reg) && /onChatEvent/.test(reg))
  check(
    '★ 渲染层订阅了 ext:send（不然点了发送界面没反应）',
    /ext:send/.test(hookSrc) && /sendMessage/.test(hookSrc),
  )
  check('★ 渲染层用 onEvent 订（不能用每轮内部那条——那时还没有轮次）', /onEvent\?\./.test(hookSrc))
  check('★ preload 白名单里有 chat:event（不然 ext:send 到不了渲染层）', /'chat:event'/.test(preload))
  check('★ 扩展侧认推送帧（没有 id 的那些）', /msg\.push === true/.test(nativeSrc))
  check('★ 扩展侧把推送广播给侧边栏', /harbor-push/.test(nativeSrc))
  check('★ SW 有 chat-send 入口', /'chat-send'/.test(swSrc) && /sendChatMessage/.test(swSrc))
  check('★ SW 有 chat-resume 入口', /'chat-resume'/.test(swSrc) && /resumeChat/.test(swSrc))
  check('★ SW 有 session-active 入口', /'session-active'/.test(swSrc))
  check('★ 侧边栏有输入框 + 发送（真的能发）', /消息输入框/.test(panelSrc) && /chat-send/.test(panelSrc))
  check('★ 侧边栏只认更大 seq（防重排把旧片盖上来）', /seq <= prev\.seq/.test(panelSrc))
  check('★ 侧边栏显示的是主进程给的原话（不自己编错误文案）', /res\?\.error/.test(panelSrc))
  check('★ 3c：侧边栏**已做**切会话（点条目 → session-select）', /onSelectSession/.test(panelSrc))
  check('★ 3c：SW 有选会话 / 新建入口', /'session-select'/.test(swSrc) && /'session-new'/.test(swSrc))

  /* ── ⑥ Phase 3b 布局返工：三段堆叠 → 顶栏三区 + 对话区 + 会话抽屉 ── */
  group('扩展对话 · 布局（顶栏三区 / 左侧抽屉 / 锚点唯一）')

  const appSrc = readFileSync(join(ROOT, 'harbor-edge/src/sidepanel/App.tsx'), 'utf8')
  const drawerSrc = readFileSync(join(ROOT, 'harbor-edge/src/sidepanel/SessionDrawer.tsx'), 'utf8')
  const readBtnSrc = readFileSync(join(ROOT, 'harbor-edge/src/sidepanel/ReadPageButton.tsx'), 'utf8')
  const probePanelSrc = readFileSync(join(ROOT, 'harbor-edge/lib/ext-probe-panel.cjs'), 'utf8')
  const cssSrc = readFileSync(join(ROOT, 'harbor-edge/src/sidepanel/sidepanel.css'), 'utf8')

  check('★ 会话列表不再常驻（SessionList 已删，App 不再引用）', !/SessionList/.test(appSrc))
  check('★ 抽屉默认收起（初始 false —— 侧边栏窄，不能常驻）', /const \[drawer, setDrawer\] = useState\(false\)/.test(appSrc))
  /* 顶栏三区：左 ☰ / 中 状态区 / 右 新建+设置 */
  check('★ 顶栏左是 ☰（免文字图标，lucide Menu）', /<Menu\b/.test(appSrc) && /label="选择对话"/.test(appSrc))
  check('★ 顶栏中是状态区（连接状态 + 当前会话名）', /aria-label="连接状态"/.test(appSrc) && /aria-label="当前对话"/.test(appSrc))
  check('★ 顶栏右是 新建 + 设置', /label="新建对话"/.test(appSrc) && /label="设置"/.test(appSrc))
  /* 抽屉：覆盖式 + 从左侧滑出 + 点外面收起 */
  check('★ 会话列表搬进抽屉（覆盖式 absolute inset-0，不是并排）', /absolute inset-0/.test(drawerSrc))
  check('★ 抽屉从**左侧**滑出（translateX，不是从上 translateY）', /translateX\(-100%\)/.test(cssSrc) && !/translateY\(-100%\)/.test(cssSrc))
  check('★ 点抽屉外面能收起（背板 onClick=onClose，面板自己 stopPropagation）', /onClick=\{onClose\}/.test(drawerSrc) && /stopPropagation/.test(drawerSrc))
  /*
   * ★ 这条挡的是最难查的假绿：☰ 与抽屉**同名**时，CLICK_TITLE_EXPR 会点到抽屉自身
   *   （点自己 = 什么也没发生，判据照样过）。名字必须分开。
   */
  check('★ ☰（选择对话）与抽屉（会话抽屉）**不同名**', /aria-label="选择对话"/.test(appSrc) && /aria-label="会话抽屉"/.test(drawerSrc))
  /*
   * ★ 这条守的是「状态锚点唯一」：ext-probe 的 `STATUS_TEXT_EXPR` 取文档里**第一个**
   *   role=status + aria-live 的元素。顶栏的连接文字若也带上 aria-live，就会把它
   *   顶掉 —— accept-phase2 / 3a 的「读当前页给人话」当场变假红（像产品坏了）。
   *
   * ⚠️ 判据必须匹配**带引号的属性形态**，不能只匹配裸词 —— 文件头注释里正解释这件事，
   *   写裸词会被自己的注释判红（156 那次「注释里提到 pendingRead」同族）。
   */
  check(
    '★ 状态锚点唯一：对话区一个 role=status + aria-live，顶栏一个都没有',
    (panelSrc.match(/role="status"/g) ?? []).length === 1 &&
      /aria-live="polite"/.test(panelSrc) &&
      !/aria-live=/.test(appSrc),
  )
  check('★ 顶栏连接点只有 role=status、**没有** aria-live（不然会顶掉状态行）', /role="status"/.test(appSrc))
  check(
    '★ 「读当前页」是图标按钮（只能按 aria-label 找，没有可见文字）',
    /label="读当前页"/.test(readBtnSrc) && !/>\s*读当前页\s*</.test(readBtnSrc),
  )
  check('★ 抽屉条目**可点**（button + onSelect，3c）', /<button/.test(drawerSrc) && /onSelect\(s\.id\)/.test(drawerSrc))
  check('★ App 订阅 session:selected（主进程推的选中，跟它走）', /session:selected/.test(appSrc))
  check('★ 顶栏 ＋ 是真的（onClick=newSession，不是占位）', /onClick=\{newSession\}/.test(appSrc))
  check(
    '★ 验收锚点与渲染层一致（一边改了另一边没跟进 = 脚本静默失效）',
    probePanelSrc.includes('读当前页') &&
      probePanelSrc.includes('选择对话') &&
      appSrc.includes('选择对话') &&
      probePanelSrc.includes('当前对话') &&
      appSrc.includes('当前对话'),
  )
}
