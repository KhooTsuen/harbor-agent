import { useEffect, useMemo, useRef, useState } from 'react'
import type { Message } from '@/types'
import { getForkPoints, type ForkPoint } from '@/lib/branchPath'
import { useAutoScroll } from '@/hooks/useAutoScroll'
import { useAppStore } from '@/stores/useAppStore'
import { MessageItem } from './MessageItem'
import { BranchBreadcrumb } from './branch/BranchBreadcrumb'
import { LaunchScreen } from './launch/LaunchScreen'
import { MessageSkeleton } from './MessageSkeleton'
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

/* AG-038：一次渲染多少条 / 点一次「载入更早」多给多少条 / 后台自动补到多少条 */
const INITIAL_TAIL = 6
const TAIL_STEP = 24
/*
 * 渲染窗口的上限。**这个数字是功能性的，不是拍头**：
 *
 * 真机量过：这个性能夹具里一条消息≈700 个 DOM 节点。窗口 200 条 = 14.3 万节点时，
 * 「长会话 + 流式」会让主线程饱和 —— 流式每来一段都要在十几万节点上重排 +
 * 贴底写入，探针求值直接 5 秒超时（**未改动的 beta.21 同样卡死，是既有问题**）。
 * 窗口压到 24 条（≈1.7 万节点）后流式正常。
 *
 * 历史仍然是能看的：上面的「载入更早」一次给 TAIL_STEP 条，可以一页页往前翻。
 */
const AUTO_TAIL_LIMIT = 24
/* 分帧渲染：每片的目标耗时（含浏览器的 layout/paint）与每片条数上下限 */
const SLICE_BUDGET_MS = 12
const SLICE_MIN = 1
const SLICE_MAX = 4

export function MessageList({ messages, conversationId = '' }: MessageListProps) {
  /* 滚动意图（mode）+ 容器 refs + 两条迁移入口，全在 hook 里；guard 只往下传 enterFree */
  const { mode, attachScroller, attachContent, enterFollow, enterFree } =
    useAutoScroll(conversationId)
  const guard = useMemo(() => ({ enterFree }), [enterFree])

  const count = messages.length
  /*
   * ── AG-038：渐增渲染 ──
   *
   * 基准测试量出来的：**1000 条消息全渲染 = 3 秒、3 万个 DOM 节点**。
   * 真机更狠：性能夹具（代码块密集）里 200 条 = 14.3 万节点、建完要 **3.8 秒**，
   * 而那 3.8 秒是一次性的主线程阻塞（切换对话就是这么卡的）。
   *
   * 为什么不用虚拟滚动：它要靠**估算**每条的高度来摆占位块，而消息高度能差
   * 几十倍（一行回答 vs 一个代码块），估错一滚就飘 —— 那套代码因此被关掉过
   * （阈值提到不可能达到，见 git 历史）。渐增渲染没有假高度。
   *
   * 为什么是「最近 N 条」而不是「前 N 条」：聊天默认看的是最新的，
   * 而且流式追加的永远是末尾 —— 截前 N 条会让新消息根本进不了视野。
   *
   * 为什么首屏是 6 不是 12（2026-09-27 真机改的）：**首屏这一次是唯一改不了大小的一坨**
   * （后面的片都能按实测代价自适应），真机量过：性能夹具里 12 条 ≈ 9.9k 节点，
   * 一次提交带出 **70–107ms 长任务**（切千条会话那次卡顿就是它）。降到 6 条 = 一半节点。
   */
  const [tailCount, setTailCount] = useState(INITIAL_TAIL)
  /*
   * ── 分帧补上剩下的（真机数据驱动）──
   *
   * 真机量过：1000 条会话一次画 200 条 = 14.3 万个 DOM 节点、建完要 **3.8 秒**，
   * 而那 3.8 秒是一次性的主线程阻塞（长任务红线 50ms，切换对话就是这么卡的）。
   * 解析并不慢，贵在建节点与随之而来的 layout/paint（同一个会话里解析 5000 字
   * 只 14ms，渲染要 1574ms）。
   *
   * 所以不再一口气建完：先画最近 6 条，剩下的**一片一片**补，每片的目标耗时
   * 是 SLICE_BUDGET_MS。片大小按**上一片的真实间隔**自适应 —— 注意不能只量
   * React 的 commit：真机第一次改的时候就是这么量的，结果量到 4ms 却触发了
   * 600ms 长任务（浏览器在 commit 之后才做 layout/paint）。所以这里量的是
   * 「上一片开始 → 这一片开始」的整段时间，减去自己等的 16ms。
   */
  /* 想画到多少条（自动补的上限，或用户点「载入更早」之后的目标） */
  const [want, setWant] = useState(AUTO_TAIL_LIMIT)
  /* 起始片大小也压小：第一片不参与自适应（还没量过代价），起始就是 6 会把第一片变成第二个大提交 */
  const sliceRef = useRef({ size: 3, at: 0 })
  const hiddenCount = Math.max(0, count - tailCount)
  const visibleMessages = useMemo(
    () => (hiddenCount > 0 ? messages.slice(-tailCount) : messages),
    [messages, tailCount, hiddenCount],
  )

  /*
   * 切对话 / 重开：回到「一小口 + 自动补到上限」。
   * 不重置的话，上一条会话已经补到 40 条，切下一条又会一口气建完。
   */
  useEffect(() => {
    setWant(AUTO_TAIL_LIMIT)
    sliceRef.current = { size: 3, at: 0 }
    setTailCount(INITIAL_TAIL)
  }, [conversationId])

  useEffect(() => {
    const target = Math.min(want, count)
    if (tailCount >= target) return
    /* 让浏览器先把这一帧画完、把输入处理完，再补下一片 */
    const timer = window.setTimeout(() => {
      const slice = sliceRef.current
      const nowMs = performance.now()
      if (slice.at) {
        /* 上一片的真实代价 = 两片之间 − 我主动等的 16ms（含浏览器的 layout/paint） */
        const busy = Math.max(4, nowMs - slice.at - 16)
        slice.size = Math.min(
          SLICE_MAX,
          Math.max(SLICE_MIN, Math.round((slice.size * SLICE_BUDGET_MS) / busy)),
        )
      }
      slice.at = nowMs
      setTailCount((value) => Math.min(value + slice.size, target))
    }, 16)
    return () => window.clearTimeout(timer)
  }, [tailCount, count, want])
  /* 分支路径：一次算好（面包屑 + 每条消息的 L 标都查这一份，别各自扫全表） */
  const forks = useMemo(() => getForkPoints(messages), [messages])
  const forkMap = useMemo(() => new Map<string, ForkPoint>(forks.map((f) => [f.id, f])), [forks])
  /* 后台还在补：这时候不给「载入更早」按钮（它补完才有意义，免得一闪一闪） */
  const autoGrowing = tailCount < Math.min(want, count)
  /*
   * 消息正在从磁盘读（openFromDisk 的 await 期间，messages 还是空数组）：
   * 这跟「刚建的空对话」长得一模一样 —— 但绝不能当成后者去渲染开屏，
   * 开屏要跑一串 IPC 扫描 + 画灯塔，然后马上被真消息顶掉（真机量到那一次就是切换卡顿）。
   */
  const loading = useAppStore((s) => s.loadingThreadId === conversationId)

  if (messages.length === 0) {
    if (loading) return <MessageSkeleton />
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
            {hiddenCount > 0 && !autoGrowing ? (
              <button
                type="button"
                /* 点一次也**不一口气建**：把目标加上去，仍由上面的切片器一片一片补 */
                onClick={() => setWant((value) => value + TAIL_STEP)}
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
