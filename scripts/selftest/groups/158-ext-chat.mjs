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

  /** 造一个 relay（`win` = 主窗口在不在；`busy` = 哪些会话在跑） */
  function makeRelay({ win = {}, busy = [], active = 'sess_a' } = {}) {
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
      getActiveSession: () => active,
    })
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

  const rNoSess = makeRelay({ active: '' })
  check('★ 没有打开的会话 → NO_SESSION', rNoSess.relay.handleSend({ text: 'hi' }).error?.code === P.ERR.NO_SESSION)

  /* ── ② SESSION_BUSY（3b 唯一新增的判据） ── */
  group('扩展对话 · SESSION_BUSY（按 streams 里的 sessionId 扫）')

  const rBusy = makeRelay({ busy: ['sess_a'] })
  const busy = rBusy.relay.handleSend({ text: 'hi' })
  check('★ 那条会话正在跑 → SESSION_BUSY + 人话（不静默排队）', busy.ok === false && busy.error.code === P.ERR.SESSION_BUSY, busy.error?.message)
  check('★ 人话里说清是「正在别处运行」', /正在别处运行/.test(String(busy.error?.message)))
  check('★ 忙的时候不推给渲染层（否则它会静默排队，用户以为消息丢了）', rBusy.pushed.length === 0)

  const rOther = makeRelay({ busy: ['sess_other'] })
  check('★ 别的会话在跑不算忙（只比 sessionId）', rOther.relay.handleSend({ text: 'hi' }).ok === true)

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
  const swSrc = readFileSync(join(ROOT, 'harbor-edge/extension/service-worker.js'), 'utf8')
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
  check('★ 侧边栏仍没做切会话（3c）', !/switch-session|onSelectSession/.test(panelSrc))

  /* ── ⑥ Phase 3b 布局返工：三段堆叠 → 顶栏 + 对话区 + 会话抽屉 ── */
  group('扩展对话 · 布局（顶栏 / 抽屉 / 状态锚点唯一）')

  const appSrc = readFileSync(join(ROOT, 'harbor-edge/src/sidepanel/App.tsx'), 'utf8')
  const drawerSrc = readFileSync(join(ROOT, 'harbor-edge/src/sidepanel/SessionDrawer.tsx'), 'utf8')
  const readBtnSrc = readFileSync(join(ROOT, 'harbor-edge/src/sidepanel/ReadPageButton.tsx'), 'utf8')
  const panelProbe = readFileSync(join(ROOT, 'harbor-edge/lib/ext-probe-panel.cjs'), 'utf8')

  check('★ 会话列表不再常驻（SessionList 已删，App 不再引用）', !/SessionList/.test(appSrc))
  check('★ 会话列表搬进抽屉（覆盖式 absolute inset-0，不是并排）', /absolute inset-0/.test(drawerSrc))
  check('★ 抽屉默认收起（初始 false —— 侧边栏窄，不能常驻）', /const \[drawer, setDrawer\] = useState\(false\)/.test(appSrc))
  /*
   * ★ 这条守的是「状态锚点唯一」：ext-probe 的 `STATUS_TEXT_EXPR` 取文档里**第一个**
   *   `[role=status][aria-live=polite]`。顶栏的连接文字若也带上 aria-live，就会把它
   *   顶掉 —— accept-phase2 / 3a 的「读当前页给人话」当场变假红（看起来像产品坏了）。
   *
   * ⚠️ 判据必须匹配**带引号的属性形态**（`aria-live="polite"`），不能只匹配
   *    `aria-live` —— 文件头注释里正解释这件事，写裸词会被自己的注释判红
   *    （156 那次「注释里提到 pendingRead」同族）。
   */
  check(
    '★ 状态锚点唯一：对话区一个 role=status + aria-live，顶栏一个都没有',
    (panelSrc.match(/role="status"/g) ?? []).length === 1 &&
      /aria-live="polite"/.test(panelSrc) &&
      !/aria-live="polite"/.test(appSrc),
  )
  check(
    '★ 「读当前页」是图标按钮（只能按 aria-label 找，没有可见文字）',
    /label="读当前页"/.test(readBtnSrc) && !/>\s*读当前页\s*</.test(readBtnSrc),
  )
  check(
    '★ 验收锚点与渲染层一致（一边改了另一边没跟进 = 脚本静默失效）',
    panelProbe.includes('读当前页') && panelProbe.includes('选择对话') && appSrc.includes('选择对话'),
  )
}
