import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Message } from '@/types'
import { getForkPoints, type ForkPoint } from '@/lib/branchPath'
import type { MessageAnchor } from '@/lib/scrollAnchor'
import { useAutoScroll } from '@/hooks/useAutoScroll'
import { useAppStore } from '@/stores/useAppStore'
import { useScrollStore } from '@/stores/useScrollStore'
import { MessageItem } from './MessageItem'
import { LaunchScreen } from './launch/LaunchScreen'
import { MessageSkeleton } from './MessageSkeleton'
import { ScrollGuardContext } from './scrollGuard'
import { CheckpointRollbackBar } from './rollback/CheckpointRollbackBar'

/* ══════════════════════════════════════════════════════════════
   MessageList

   滚动策略是一个显式状态机（`hooks/useAutoScroll.ts`）：
     FOLLOW 看最新（新内容自动跟上）/ FREE 看历史（程序一行都不写）
   状态只由用户动作迁移，程序行为（流式、增删消息、切换对话）不改它。

   ★ P3 #10：这里曾经在消息区顶部渲染一条 `BranchBreadcrumb`
     （「主干 › 提问 35 · 2/3 › 答复 1 › 1/2 › 当前」）。它占一整行高度、
     长对话里几乎天天出现，而切分支的主要入口是侧栏分支树与消息旁的
     `ForkBadge` —— 顶部那条属于重复导航。已撤掉，**分支功能一个没动**：
     分叉点仍由 `forkMap` 算出并挂在每条消息上（`MessageItem` 的 fork prop）。
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
/*
 * 恢复阅读位置时，渲染窗口**最多**能扩到多少条。一条消息≈700 节点，200 条 =
 * 14.3 万节点时流式会把主线程压死；96 条 ≈ 6.7 万，是已知卡死量的一半以下。
 * 目标比这还远时（几千条的老对话）：锚点落到**窗口内最早那条**，仍是他当时那一带。
 */
const RESTORE_TAIL_LIMIT = AUTO_TAIL_LIMIT * 4
/* 分帧渲染：每片的目标耗时（含浏览器的 layout/paint）与每片条数上下限 */
const SLICE_BUDGET_MS = 12
const SLICE_MIN = 1
const SLICE_MAX = 4

interface WindowPlan {
  /** 首帧就渲染这么多条（从末尾数） */
  tail: number
  /** 之后的自动补片上限 */
  want: number
  /** 需要改落点时（目标被删 / 超出上限）填这里，交给 useAutoScroll */
  retarget: MessageAnchor | null
  /** true = 必须等窗口真的盖住目标才放行落位（在阅读历史）；false = 立即放行 */
  pending: boolean
}

/*
 * 切回一条对话时要摆多大的渲染窗口 —— 纯函数，输入只有「全部消息 + 离开时的锚点」。
 *
 * · **在阅读历史**（有锚点）：一次摆到「盖住目标」的条数（上限 RESTORE_TAIL_LIMIT）。
 *   为什么不能分片补：每补一片目标上方就多一段内容、落点跟着变一次，屏幕一段段往上跳
 *   （用户原话「每次都从下往上滑」），最后停在哪还要看补到第几片时恰好对上。
 *   上限 96 条 ≈ 6.7 万节点（已知卡死量 14.3 万的一半以下），不是「摊开整段历史」。
 * · **在跟最新 / 没有锚点**：回到「一小口 + 自动补到上限」——否则上一条补到 40 条，
 *   切下一条又会一口气建完。这条路的补片只影响尾部，与落点无关。
 */
function planWindow(messages: readonly Message[], anchor: MessageAnchor | null): WindowPlan {
  const count = messages.length
  if (!anchor) {
    return { tail: INITIAL_TAIL, want: AUTO_TAIL_LIMIT, retarget: null, pending: false }
  }
  /* 目标**确实不在 messages 里**（离开期间被删 / 老会话没有这条）才退到
     「离开时同下标」那条仍然存在的邻居 —— 仍是附近那段历史，界面稳定 */
  let at = messages.findIndex((m) => m.id === anchor.messageId)
  let retarget: MessageAnchor | null = null
  if (at < 0) {
    at = Math.max(0, Math.min(anchor.index >= 0 ? anchor.index : count - 1, count - 1))
    retarget = { messageId: messages[at].id, offset: anchor.offset, index: at }
  }
  /* 目标比上限还远：落到窗口内最早那条（偏移归零），不为到位摊开整段长历史 */
  if (count - at > RESTORE_TAIL_LIMIT) {
    const edge = count - RESTORE_TAIL_LIMIT
    return {
      tail: RESTORE_TAIL_LIMIT,
      want: RESTORE_TAIL_LIMIT,
      retarget: { messageId: messages[edge].id, offset: 0, index: edge },
      pending: true,
    }
  }
  const n = Math.max(count - at, INITIAL_TAIL)
  return { tail: n, want: n, retarget, pending: true }
}

export function MessageList({ messages, conversationId = '' }: MessageListProps) {
  const count = messages.length
  /*
   * ── AG-038：渐增渲染 ──
   *
   * 真机量过：性能夹具（代码块密集）里 200 条 = 14.3 万节点、建完 **3.8 秒**，
   * 那是一次性主线程阻塞（切换对话就是这么卡的）。不用虚拟滚动：它要靠**估算**
   * 高度摆占位块，而消息高度差几十倍（一行回答 vs 代码块），估错一滚就飘。
   * 首屏为什么是 6 不是 12：首屏是唯一改不了大小的一坨，12 条 ≈ 9.9k 节点，
   * 一次提交带出 70–107ms 长任务。
   */
  const [tailCount, setTailCount] = useState(INITIAL_TAIL)
  /* 想画到多少条（自动补的上限，或用户点「载入更早」之后的目标） */
  const [want, setWant] = useState(AUTO_TAIL_LIMIT)
  /* 滚动意图（mode）+ 容器 refs + 迁移入口，全在 hook 里；guard 只往下传 enterFree */
  const { mode, attachScroller, attachContent, enterFollow, enterFree, retarget, settleWindow } =
    useAutoScroll(conversationId)
  const guard = useMemo(() => ({ enterFree }), [enterFree])
  /* 起始片大小也压小：第一片不参与自适应（还没量过代价），起始就是 6 会把第一片变成第二个大提交 */
  const sliceRef = useRef({ size: 3, at: 0 })
  /* 窗口已按哪条对话重置过（放行判据不能拿上一条对话的窗口大小来算「补完了」） */
  const windowThreadRef = useRef<string | null>(null)
  /*
   * 切回某条对话时窗口要摆多大 —— 由 `planWindow` 一次算好，**等它真的摆出来了才放行落位**。
   *
   * 三条都是真机上踩出来的：
   *  1. **不能切完立刻放行**：这一提交才 `setTailCount(n)`，立刻放行的话 useAutoScroll
   *     拿的是**旧窗口**（目标还没进 DOM）算一刀 —— 白写，或者落在没长够高度的位置上。
   *     所以先摆窗口，等 `tailCount` 到位再 settleWindow。
   *  2. **别在 render 期改 state**（试过）：分片器的 `setTailCount(value + slice)` 会把
   *     它覆盖掉，窗口卡在一半、scrollTop 被 clamp，回来落在别处
   *     （真机抓到「还有 47 条」却只渲染 13 条）。
   *  3. **还没落位时要跟着 count 重算**：切回来那一刻 messages 是**分批到**的
   *     （先从磁盘读出一部分，再补齐），按 count=48 算出的窗口，等涨到 60 条就短了 12 条 ——
   *     目标虽然还在窗口里，但上方少了一段，落点自然差一截（真机：scrollTop 77、目标在 1472px 处）。
   *     落位完成（planRef 清空）之后就不再动窗口。
   */
  const planRef = useRef<WindowPlan | null>(null)
  useLayoutEffect(() => {
    if (count === 0) return
    const switching = windowThreadRef.current !== conversationId
    if (switching) {
      windowThreadRef.current = conversationId
      sliceRef.current = { size: 3, at: 0 }
    } else if (!planRef.current) return /* 已经落过位（或本来就不需要）：窗口不动 */
    const saved = conversationId ? useScrollStore.getState().byThread[conversationId] : undefined
    const plan = planWindow(messages, saved?.mode === 'free' ? saved.anchor : null)
    /* 在跟最新 / 没有锚点：这条路的补片只影响尾部、与落点无关，不必等窗口补满 */
    if (!plan.pending) {
      planRef.current = null
      setTailCount(plan.tail)
      setWant(plan.want)
      settleWindow()
      return
    }
    planRef.current = plan
    if (switching) {
      setTailCount(plan.tail)
      setWant(plan.want)
      return /* 这一提交只是把窗口摆出来，落位留给下一次（窗口真的画出来之后） */
    }
    /* 窗口没盖到目标之前一个字节都不写 —— 逐片补齐它也逐片重算 */
    if (tailCount < Math.min(plan.want, count)) {
      setWant(plan.want)
      return
    }
    planRef.current = null
    if (plan.retarget) retarget(plan.retarget)
    settleWindow()
  }, [conversationId, count, messages, tailCount, settleWindow, retarget])

  const hiddenCount = Math.max(0, count - tailCount)
  /* 渲染窗口在整个列表里的起始下标（给每条消息带上绝对下标：目标被删时按下标降级） */
  const windowStart = hiddenCount > 0 ? count - tailCount : 0
  const visibleMessages = useMemo(
    () => (hiddenCount > 0 ? messages.slice(-tailCount) : messages),
    [messages, tailCount, hiddenCount],
  )

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
              {visibleMessages.map((message, i) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  index={windowStart + i}
                  fork={forkMap.get(message.id)}
                />
              ))}{' '}
            </ScrollGuardContext.Provider>
            {/*
              AG-052：对话结束后下方那个「撤销检查点之后的改动」。
              挂在消息末尾而不是输入框上方：任务相关的东西不占输入框那一排
              （AG-030 刚把噪音收拾干净，别又加一层）。它自己判断该不该出
              （任务停了、且有检查点才渲染）。
            */}
            <CheckpointRollbackBar conversationId={conversationId} />
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
