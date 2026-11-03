/**
 * 侧边栏的**对话流**（历史 + 正在流的那一轮）—— 2026-11-03
 *
 * ── 它解决什么 ────────────────────────────────────────────────
 *
 * 以前这里只画 `TurnBubble`（当前这一轮）。主窗口显示整条会话，侧边栏打开时
 * 却像刚开的新对话 —— 这是「侧边栏与主对话分裂」里最实的一条。
 *
 * ── 视觉为什么和主窗口像 ──────────────────────────────────────
 *
 * 不是照抄一份样式，而是**用同一套 token 与同一个分法**：
 *   · 用户那条：与 `src/components/chat/message/UserMessage.tsx` 同款右对齐气泡
 *     （`rounded-md rounded-br-sm bg-bg-raised px-3.5 py-2`）；
 *   · 助手那条：与 `MessageItem.tsx` 同款**左对齐、无气泡**的正文（`max-w-[86ch]`）；
 *   · 工具行：与 `chat/message/ToolLine.tsx` 同款**整组一行**（摘要 + 步数 + 用时，
 *     点开摊明细）—— 渲染在 `ToolGroup.tsx`（形状不同，不能直接复用那个组件）；
 *   · 出错：与 `MessageItem` 的出错块同色（`colorOf('failed')` 那一路的红）。
 * 宽度仍是侧边栏的（400px），所以气泡百分比沿用主窗口的 78% —— 同一口径。
 *
 * ⚠️ 两条验收锚点（改了就静默失效）：
 *   · `回复正文` —— **只有正在流的那一条**带（见 `TurnBubble` 的 `anchor` 参数）；
 *   · `发送提示` —— 在 ChatPanel（状态行），本文件不碰。
 *
 * 合并规则与截断提示在 `mergeMessages.ts`（纯函数，自检直接跑）——
 * 本文件只负责「取数据 + 画」，不自己判重复。
 */

import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IngestedNote } from '@/components/chat/message/IngestedNote'
import { ThinkBlock } from '@/components/chat/ProcessBlocks'
import { colorOf } from '@/lib/statusLanguage'
import { MessageBody, type TurnView } from './TurnBubble'
import { ToolGroup } from './ToolGroup'
import { SideActions } from './SideActions'
import { mergeMessages, truncatedHint, type SideMessage } from './mergeMessages'
import { useSessionHistory } from './useSessionHistory'

/** 助手那一条（左对齐、无气泡 —— 与 `MessageItem` 同口径） */
function AssistantLine({ message }: { message: SideMessage }) {
  const thinking = String(message.reasoning ?? '').trim()
  return (
    /* `group` 是悬停操作条的前提（主窗口挂在 MessageItem 的 article 上）—— 漏了它操作条永远看不见 */
    <div className="group w-full max-w-[86ch]">
      {/*
        思考（A①，2026-11-04）：与主窗口**同一个组件**（`chat/ProcessBlocks` 的
        `ThinkBlock`）—— 默认折叠、点开看原文。它内部的 `useScrollGuard()` 在
        没有 Provider 时返回 null，侧边栏不用包 Provider。

        `streaming` 只是「这一轮还在跑、正文还没出」→ 文案变成「正在思考…」。
        ★ 2026-11-04：`reasoning` 分片现在真的接到了（`useChatStream` 累加 →
        `mergeMessages` 合进这一条），所以流式中也看得见，不必等跑完重读历史。
      */}
      {thinking ? (
        <ThinkBlock
          text={thinking}
          streaming={message.streaming === true && !message.text.trim()}
        />
      ) : null}
      {/*
        工具：**整组一行**（与主窗口同一个粒度 —— 「读取 3 个文件 · 成功 · 4 步 · 用时 1.2 秒」），
        点开才摊明细。以前是每条工具一行，跑 20 步就把 400px 面板挤满。
        为什么不能直接 import 主窗口的 ToolLine：它要 `ToolRunRecord.summary` 之外的
        `progress` / `subagent`，而这边只有内核瘦身后的那份 —— 见 ToolGroup 文件头。
      */}
      {message.toolRuns && message.toolRuns.length > 0 ? (
        <ToolGroup runs={message.toolRuns} />
      ) : null}
      {message.error ? (
        /* 出错块（D④）：类名与 `MessageItem` 那一套逐条对齐 —— 宽度不同，观感要一致 */
        <div
          role="alert"
          aria-label={message.live ? '回复错误' : '历史回复错误'}
          className="flex items-start gap-2 rounded border px-3 py-2"
          style={{ borderColor: 'rgb(229 83 75 / 0.4)', background: 'rgb(229 83 75 / 0.08)' }}
        >
          {/* ★ 2026-11-04 真机探针查出：`var(--text-danger)` 这个变量不存在（计算色是正文白，
              错误块只有边框红、字不红）。改成 `colorOf('failed')` —— 状态色只有一处定义。 */}
          <span className="text-xs leading-relaxed" style={{ color: colorOf('failed') }}>
            {message.error}
          </span>
        </div>
      ) : null}
      {message.text ? (
        /* 历史条不带 `回复正文` 锚点（见 TurnBubble 的 anchor 参数注释） */
        <MessageBody
          text={message.text}
          streaming={message.streaming === true}
          anchor={message.live === true}
        />
      ) : null}
      {message.truncated ? (
        <p className="mt-0.5 text-2xs text-fg-tertiary">
          这条比较长，侧边栏只显示开头（完整内容在 Harbor 主窗口）
        </p>
      ) : null}
      {message.interrupted ? (
        <p className="mt-0.5 text-2xs text-fg-tertiary">这条回复没写完 —— 上次运行被打断了</p>
      ) : null}
      {message.durationMs && message.durationMs > 0 ? (
        <p className="mt-0.5 text-2xs text-fg-tertiary">
          用时 {(message.durationMs / 1000).toFixed(1)} 秒
        </p>
      ) : null}
      {/* 悬停操作条（A③ / D③）：复制正文 / 复制完整记录 / 时间戳 —— 与主窗口同一套动作 */}
      <SideActions message={message} copy />
    </div>
  )
}

/** 用户那一条（右对齐气泡 —— 与 `UserMessage` 同口径） */
function UserLine({ message }: { message: SideMessage }) {
  return (
    <div className="group flex max-w-[78%] flex-col items-end gap-1 self-end">
      <div className="rounded-md rounded-br-sm bg-bg-raised px-3.5 py-2 text-base leading-relaxed text-fg-primary">
        <p className="whitespace-pre-wrap break-words">{message.text}</p>
      </div>
      {/* 用户那条只放时间戳（主窗口用户条也没有复制；编辑 / 分支要改 IPC 通道，不在这轮） */}
      <SideActions message={message} align="end" />
    </div>
  )
}

/**
 * @param props.sessionId 侧边栏自己看的那条
 * @param props.connected 通道连上没有（没连上就不问历史，见 useSessionHistory ②）
 * @param props.turn 正在流的那一轮（`useChatStream` 的 turn）
 * @param props.tick 轮次变化计数（每跑完一轮 +1 → 重读历史）
 * @param props.sentTick 发送成功计数（+1 → 重读历史）
 * @param props.onRegenerate 点「重新生成」（有历史时也显示，与主窗口一致）
 * @param props.regenerating 正在等回执（防连点）
 */
export function MessageStream({
  sessionId,
  connected,
  turn,
  tick,
  sentTick,
  onRegenerate,
  regenerating,
}: {
  sessionId: string
  connected: boolean
  turn: TurnView | null
  tick: number
  sentTick: number
  onRegenerate?: () => void
  regenerating?: boolean
}) {
  const history = useSessionHistory({ sessionId, connected, tick, sentTick })
  const list = mergeMessages(history.messages, turn)
  const hint = truncatedHint(history.dropped)

  if (list.length === 0) {
    /* 空状态：加载中 / 读到过但确实是空的 / 读失败 —— 三种说清，不混成一句 */
    return (
      <div className="flex h-full items-center justify-center px-2">
        <p className="text-center text-2xs leading-relaxed text-fg-tertiary">
          {history.loading ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              正在读这条对话…
            </span>
          ) : !connected ? (
            '还没连上 Harbor'
          ) : sessionId ? (
            history.error ? (
              `没读到这条对话的消息：${history.error}`
            ) : (
              '这条对话还没有消息'
            )
          ) : (
            '在下面输入'
          )}
        </p>
      </div>
    )
  }

  return (
    /*
     * 列表容器（D①）：间距按主窗口的档位对齐（那边 `gap-5`），但**内边距不在这层加** ——
     * 外层 `AutoscrollBox` 已经有 `px-3 py-2`，这层再写一份就是 24px 的双重留白，
     * 400px 面板会被挤掉一圈。所以「贴边留白」只有一处来源，这里只补间距与一点上下气口。
     */
    <div className="flex flex-col gap-4 py-1">
      {hint ? <p className="text-2xs text-fg-tertiary">{hint}</p> : null}
      {list.map((message) =>
        message.source === 'extension' ? (
          /* 扩展读到的网页 / 操作回执：一行摘要（与主窗口同一个组件，硬约束 #9） */
          <IngestedNote key={message.id} content={message.text} timestamp={message.timestamp} />
        ) : message.role === 'user' ? (
          <UserLine key={message.id} message={message} />
        ) : message.role === 'system' ? (
          /* 压缩点这类系统条：与主窗口一样低调（一行居中的灰字） */
          <p key={message.id} className="self-center text-center text-2xs text-fg-tertiary">
            {message.text}
          </p>
        ) : (
          <AssistantLine key={message.id} message={message} />
        ),
      )}
      {/* 重新生成：有历史就显示（与主窗口一致）；正在流时不显示（没什么可重来的） */}
      {onRegenerate && sessionId && connected && !(turn && !turn.done) ? (
        <Button size="sm" variant="ghost" disabled={regenerating} onClick={onRegenerate}>
          重新生成
        </Button>
      ) : null}
    </div>
  )
}
