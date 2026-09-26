import { useMemo, useState } from 'react'
import type { Message } from '@/types'
import { getForkPoints, type ForkPoint } from '@/lib/branchPath'
import { useAutoScroll } from '@/hooks/useAutoScroll'
import { MessageItem } from './MessageItem'
import { BranchBreadcrumb } from './branch/BranchBreadcrumb'
import { LaunchScreen } from './launch/LaunchScreen'
import { ScrollGuardContext } from './scrollGuard'

/* ══════════════════════════════════════════════════════════════
   MessageList

   滚动策略是一个显式状态机（`hooks/useAutoScroll.ts`）：
     FOLLOW 看最新（新内容自动跟上）/ FREE 看历史（程序一行都不写）
   状态只由用户动作迁移，程序行为（流式、增删消息、切换对话）不改它。
   ══════════════════════════════════════════════════════════════ */

export interface MessageListProps {
  messages: readonly Message[]
  /** 当前对话 id —— 每条对话各自记「看最新 / 看历史」，切走切回来还原（useScrollStore） */
  conversationId?: string
}

/* AG-038：一次渲染多少条 / 点一次「载入更早」多给多少条 */
const INITIAL_TAIL = 200
const TAIL_STEP = 300

export function MessageList({ messages, conversationId = '' }: MessageListProps) {
  /* 滚动意图（mode）+ 容器 refs + 两条迁移入口，全在 hook 里；guard 只往下传 enterFree */
  const { mode, attachScroller, attachContent, enterFollow, enterFree } =
    useAutoScroll(conversationId)
  const guard = useMemo(() => ({ enterFree }), [enterFree])

  const count = messages.length
  /*
   * ── AG-038：渐增渲染 ──
   *
   * 基准测试量出来的：**1000 条消息全渲染 = 3 秒、3 万个 DOM 节点**
   * （每条约 30 个节点）。这就是「Agent 用得越久越卡」的来源。
   *
   * 为什么不用虚拟滚动：它要靠**估算**每条的高度来摆占位块，而消息高度能差
   * 几十倍（一行回答 vs 一个代码块），估错一滚就飘 —— 那套代码因此被关掉过
   * （阈值提到不可能达到，见 git 历史）。渐增渲染没有假高度：
   * 默认只渲染最近 TAIL_STEP 条，上面给一个「载入更早的」按钮，
   * 滚动仍是原生滚动，永远不会飘。
   *
   * 为什么是「最近 N 条」而不是「前 N 条」：聊天默认看的是最新的，
   * 而且流式追加的永远是末尾 —— 截前 N 条会让新消息根本进不了视野。
   */
  const [tailCount, setTailCount] = useState(INITIAL_TAIL)
  const hiddenCount = Math.max(0, count - tailCount)
  const visibleMessages = useMemo(
    () => (hiddenCount > 0 ? messages.slice(-tailCount) : messages),
    [messages, tailCount, hiddenCount],
  )
  /* 分支路径：一次算好（面包屑 + 每条消息的 L 标都查这一份，别各自扫全表） */
  const forks = useMemo(() => getForkPoints(messages), [messages])
  const forkMap = useMemo(() => new Map<string, ForkPoint>(forks.map((f) => [f.id, f])), [forks])

  if (messages.length === 0) {
    /* 开屏（设计文档 §5）：状态层 + 性格层 + 灯塔，见 launch/LaunchScreen.tsx */
    return <LaunchScreen />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BranchBreadcrumb forks={forks} />
      <div className="relative min-h-0 flex-1">
        {/*
         * tabIndex=-1：点一下消息区就聚焦，PageUp/PageDown/Home/End 才收得到。
         * [overflow-anchor:none]：关掉浏览器**原生 scroll anchoring** ——
         * 它会在展开块/图片加载时自己改 scrollTop，而且不给任何标记，状态机
         * 只能把那个 scroll 事件当成「用户滚到底」，于是 FREE 被翻回 FOLLOW
         * （真机复现过：展开 3534px 的块 → 模式翻回 FOLLOW、按钮消失）。
         * 补偿改由 useAutoScroll 自己做，那样才带得上「这是程序写的」标记。
         */}
        <div
          ref={attachScroller}
          tabIndex={-1}
          className="h-full overflow-y-auto outline-none [overflow-anchor:none]"
        >
          <div ref={attachContent} className="mx-auto flex max-w-3xl flex-col gap-5 px-5 py-5">
            {hiddenCount > 0 ? (
              <button
                type="button"
                onClick={() => setTailCount((value) => value + TAIL_STEP)}
                className="mx-auto rounded-pill border border-line-hairline px-3 py-1 text-2xs text-fg-tertiary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary"
              >
                载入更早的 {Math.min(TAIL_STEP, hiddenCount)} 条（还有 {hiddenCount} 条）
              </button>
            ) : null}
            <ScrollGuardContext.Provider value={guard}>
              {visibleMessages.map((message) => (
                <MessageItem key={message.id} message={message} fork={forkMap.get(message.id)} />
              ))}
            </ScrollGuardContext.Provider>
          </div>
        </div>

        {/*
         * 「回到底部」。
         *
         * 显式状态机的界面投影：FREE（用户在看历史）才出现 —— 他往上翻了，
         * Agent 还在后面写，得给个东西告诉他「后面有新的」；点一下 = 迁移规则 5。
         * FOLLOW 时藏起来：你在看最新内容，没有「回去」这回事。
         */}
        {mode === 'free' ? (
          <button
            type="button"
            onClick={enterFollow}
            className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-pill border border-line-hairline bg-bg-raised px-3 py-1.5 text-2xs text-fg-secondary shadow-lg transition-colors hover:text-fg-primary"
          >
            ↓ 回到底部
          </button>
        ) : null}
      </div>
    </div>
  )
}
