/**
 * 自检 / M02-A：侧边栏的 Markdown 渲染 + **停止生成**
 *
 * 三块：
 *   ① **Markdown 复用**（硬约束 #9）：侧边栏必须用主应用那一份解析 + 渲染，
 *      不许自己写第二套（同一段文字在两处渲染成不同块，是最典型的漂）。
 *   ② **停止生成**全链路（少一处 = 按钮点了没反应，而界面**不会报错**）。
 *   ③ **反向判据**（比正向值钱）：没在跑时停止必须**如实回绝**，不许假装停成功。
 *
 * ⚠️ 这条链跨 5 个文件、2 种语言（TS / JS / CJS）—— 所以只能「读源码钉接线 +
 *   require 真跑那个纯 CJS 的判定」。真机那一段另在 `accept-m02a.cjs`。
 */

import { readFileSync, join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const R = (p) => readFileSync(join(ROOT, p), 'utf8')

export async function run() {
  const C = require(join(ROOT, 'electron/core/ext-chat.cjs'))
  const P = require(join(ROOT, 'electron/core/ext-protocol.cjs'))

  const bubbleSrc = R('harbor-edge/src/sidepanel/TurnBubble.tsx')
  const chatSrc = R('harbor-edge/src/sidepanel/ChatPanel.tsx')
  const msgSrc = R('harbor-edge/extension/lib/messages.js')
  const swSrc = R('harbor-edge/extension/service-worker.js')
  const hostSrc = R('electron/core/ext-host-loop.cjs')
  const opsSrc = R('electron/core/ext-ops.cjs')
  const chatCs = R('electron/core/ext-chat.cjs')
  const streamSrc = R('electron/core/ext-chat-streams.cjs')
  const kindsSrc = R('electron/core/ext-kinds.cjs')
  const hookSrc = R('src/hooks/useExtBridge.ts')
  const panelSrc = R('harbor-edge/lib/ext-probe-panel.cjs')

  /* ── ① Markdown：复用主应用那一份 ── */
  group('M02-A · Markdown（复用主应用那一份，不自写第二套）')
  check('★★ 懒加载主应用的 Markdown 组件（不是自己写一个渲染器）', /import\('@\/components\/chat\/Markdown'\)/.test(bubbleSrc))
  check('★ 用 lazy + Suspense（katex / CodeBlock 不进首屏）', /lazy\(/.test(bubbleSrc) && /Suspense/.test(bubbleSrc))
  check('★★ 加载中/失败退回**纯文本**（不空白 —— 回复看不见比没有排版糟得多）', /fallback=\{<div className="whitespace-pre-wrap/.test(bubbleSrc))
  check('★★ `回复正文` 这个验收锚点还在（换渲染组件也必须在同一处）', /aria-label="回复正文"/.test(bubbleSrc))
  check('★ 一轮的显示从 ChatPanel 拆到 TurnBubble（那个文件贴 300 红线）', /from '\.\/TurnBubble'/.test(chatSrc) && /<TurnBubble turn=\{turn\}/.test(chatSrc))
  check('★ ChatPanel 里不再有第二处 `回复正文`（锚点只能一处）', (chatSrc.match(/aria-label="回复正文"/g) ?? []).length === 0)

  /* ── ② 停止生成：全链路 ── */
  group('M02-A2 · 停止生成（全链路 —— 少一处就是「点了没反应」）')
  check('★ 协议有 CHAT_ABORT（与 chat:send 同族）', P.KIND.CHAT_ABORT === 'chat:abort' && /CHAT_ABORT:/.test(kindsSrc))
  check('★ host 转发了 chat:abort（不转发 → 主进程永远收不到）', /'chat:abort': \[P\.KIND\.CHAT_ABORT/.test(hostSrc))
  check('★ host 的「只认」文案也带上了它', /chat:abort/.test(hostSrc.split('只认')[1] ?? ''))
  check('★ ops 分派表认 chat:abort', /\[P\.KIND\.CHAT_ABORT\]: \(payload\) => chat\.handleAbort/.test(opsSrc))
  check('★ SW 的路由表有 chat-abort', /'chat-abort': \(m\) => h\.abortChat/.test(msgSrc))
  check('★ SW 把 abortChat 注入了（表里有、注入漏了 = 静默失效）', /^\s{4}abortChat,$/m.test(swSrc))
  check('★ SW 的 abortChat 走 requestHost（不是本地自己停）', /requestHost\('chat:abort'/.test(swSrc))
  check('★★ 侧边栏「停止」按钮存在，且是锚点（图标按钮只能按 aria-label 找）', /aria-label="停止生成"/.test(chatSrc))
  check('★★ 锚点表里有 `停止生成`（否则验收脚本会静默失效）', /CLICK_STOP_EXPR/.test(panelSrc) && /aria-label="停止生成"/.test(panelSrc))
  check('★ 停止按钮**只在流式中出现**（没得停就不该有）', /streaming \|\| stopping \?/.test(chatSrc))

  /* ── ③ 真正的中断在渲染层（唯一一处实现） ── */
  group('M02-A2 · 真正 abort 的是渲染层（主进程手里没有 AbortController）')
  check('★★ 主进程推 `ext:abort` 请渲染层去停（不新增 IPC 通道）', /EXT_ABORT = 'ext:abort'/.test(chatCs) && /send\('chat:event', \{ type: EXT_ABORT, sessionId \}\)/.test(chatCs))
  check('★★ 它从模块里导出（自检与文档跟着这个常量走）', /EXT_ABORT, KEEP_AFTER_DONE_MS \}/.test(chatCs) || /EXT_ABORT\b[^\n]*KEEP_AFTER_DONE_MS/.test(chatCs))
  check('★★ 渲染层接住 → 调 `stopActiveRequest`（唯一一处真 abort 的实现）', /event\.type === 'ext:abort'/.test(hookSrc) && /stopActiveRequest\(tid\)/.test(hookSrc))
  check('★ 渲染层是从 turnControl 引入的（不是又写一套 abort 逻辑）', /import \{ stopActiveRequest \} from '@\/stores\/thread\/turnControl'/.test(hookSrc))
  check('★ 停止时带上 sessionId（只停那一条，不误伤别的对话）', /const tid = String\(event\.sessionId \?\? ''\)/.test(hookSrc))

  /* ── ④ 反向判据：没在跑必须如实回绝（真跑那个纯 CJS 判定） ── */
  group('M02-A2 · 反向判据（没在跑时不许假装停成功）')
  const relay = C.createChatRelay({
    streams: new Map(),
    getMainWindow: () => ({}),
    send: () => {},
  })
  const noSession = relay.handleAbort({})
  check('★★ 没说是哪条会话 → 回绝（NO_SESSION）', noSession.ok === false && noSession.error.code === P.ERR.NO_SESSION, JSON.stringify(noSession.error))
  const notRunning = relay.handleAbort({ sessionId: 'sess_x' })
  check('★★ 有会话但没在跑 → 回绝 + 明说「没什么可停的」', notRunning.ok === false && /没有正在跑的回复/.test(String(notRunning.error?.message)), JSON.stringify(notRunning.error))
  check('★ 回绝时**不带** ok:true（前端据它决定是否显示「已停止」）', notRunning.ok !== true)

  /* 有流在跑：真的推 ext:abort 给渲染层 */
  const pushed = []
  const streams = new Map([['req_1', { sessionId: 'sess_a' }]])
  const relay2 = C.createChatRelay({
    streams,
    getMainWindow: () => ({}),
    send: (ch, payload) => pushed.push({ ch, payload }),
  })
  const okCase = relay2.handleAbort({ sessionId: 'sess_a' })
  check('★★ 有流在跑 → 回 ok:true（前端据此说「已请求停止」）', okCase.ok === true, JSON.stringify(okCase))
  check('★★ 并且**真的推了** ext:abort 给渲染层', pushed.length === 1 && pushed[0].payload?.type === 'ext:abort', JSON.stringify(pushed[0]))
  check('★★ 推的 sessionId 就是要停的那条（不误伤别的对话）', pushed[0]?.payload?.sessionId === 'sess_a')
  check('★ 走的是 chat:event 通道（零新增 IPC 通道）', pushed[0]?.ch === 'chat:event')

  /* ── ⑤ 拆出去的东西没丢语义（快照 / 旁听搬走之后） ── */
  group('M02-A · 拆分没丢东西（快照 / 旁听的语义还在）')
  check('★ 快照与旁听搬到 ext-chat-streams.cjs', /function createStreamStore/.test(streamSrc) && /createStreamStore/.test(chatCs))
  check('★ 快照仍按 sessionId 找最近一条（chat:resume 的关键）', /function latestOf\(sessionId\)/.test(streamSrc) && /streamStore\.latestOf\(want\)/.test(chatCs))
  /*
   * 判据本意：`done` 那片必须推**全文**（分片丢了也能补齐）。
   * ★ 2026-10-21 放宽了一处文本形态（意图不变）：`retry` 也推全文 —— 重试时主进程会把
   *   本轮正文回滚到重试前的位置，侧栏得拿到回滚后的全文来**覆盖**，否则同一段会显示两遍。
   *   所以条件从 `type === 'done' ?` 变成了 `type === 'done' || type === 'retry' ?`。
   */
  check('★ `done` 那片仍推**全文**（分片丢了也能补齐）', /\btype === 'done'[^?]*\? snap\.text/.test(streamSrc))
  check('★ 旁听仍只认「有 requestId」的事件（没有就认不出是哪一轮）', /没有 requestId 的 chat:event/.test(streamSrc))
  check('★ KEEP_AFTER_DONE_MS 从 streams 再导出（老调用点不变）', C.KEEP_AFTER_DONE_MS === 60_000)
  check('★ 快照仍能从 relay 取到（自检用入口没断）', typeof relay.snapshotOf === 'function' && relay.snapshotOf('nope') === null)

  /* ── ⑥ 消息分派表搬走后：路由表与注入的处理器必须一一对应 ── */
  group('M02-A · 消息分派表（表里要的处理器，SW 必须都注入）')
  const routed = [...msgSrc.matchAll(/\bh\.([a-zA-Z]+)\b/g)].map((m) => m[1])
  const injected = [...(swSrc.match(/createPanelRouter\(\{([\s\S]*?)\}\)/)?.[1] ?? '').matchAll(/^\s*([a-zA-Z]+),\s*$/gm)].map((m) => m[1])
  check('★★ 路由表用到的处理器 === SW 注入的那些（漏一个就是「点了没反应」）', JSON.stringify([...new Set(routed)].sort()) === JSON.stringify([...injected].sort()), `路由 ${[...new Set(routed)].join(',')} / 注入 ${injected.join(',')}`)
  check('★ SW 的 if 链真的搬走了（它不再自己写 onMessage 分支）', !/msg\.type === 'chat-send'/.test(swSrc) && /createPanelRouter\(/.test(swSrc))
  check('★ 不认识的 type 不接管（单向广播走这条 —— 别回 ok:false 造成多余往返）', /if \(!run\) return undefined/.test(msgSrc))
  check('★ 异步分支保持通道（return true）—— 少了它 sendResponse 永远送不出去', /return true \/\* ★ 异步/.test(msgSrc))

  /* ── ⑦ 锚点不变量（新增 UI 不许破坏 STATUS_TEXT_EXPR 的唯一性） ── */
  group('M02-A · 锚点不变量（新 UI 不许破坏既有判据）')
  check('★★ 新增的停止按钮**不带** aria-live（那份唯一性归「发送提示」）', !/aria-label="停止生成"[^>]*aria-live/.test(chatSrc))
  check('★ `发送提示` 仍然只在 ChatPanel 一处', (chatSrc.match(/aria-label="发送提示"/g) ?? []).length === 1)
  check('★ TurnBubble 里没有角色为 status + aria-live 的元素', !/role="status"/.test(bubbleSrc))
}
