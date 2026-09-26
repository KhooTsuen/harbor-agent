import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { anchorShift, readAnchor, type ScrollAnchor } from '@/lib/scrollAnchor'
import { useScrollStore, type ScrollMode } from '@/stores/useScrollStore'

/* ══════════════════════════════════════════════════════════════
   自动滚动 —— 显式状态机，不做任何推断

   滚动**意图**只有两种，只由用户显式表达：
     FOLLOW 我在看最新内容，有新内容自动跟上 / FREE 我在看历史，别动我的视图

   ── 状态迁移（只有这五条，严格 FREE 优先）─────────────────────
     1. 向上滚（滚轮 deltaY<0 / PageUp / Home / 拖滚动条向上）→ FREE
     2. 向下滚但没到真正的底 → FREE
     3. 向下滚到「离底 ≤ 4px」 → FOLLOW
     4. 点开/折叠可展开元素（guard.enterFree）→ FREE
     5. 点「回到底部」（enterFollow）→ FOLLOW
   **程序行为**（流式新内容 / 布局变化 / 消息增删 / 切换对话）→ 状态不变。

   ── 内容变化时的行为（只有两条）──────────────────────────────
     FOLLOW → scrollTop = scrollHeight（贴底）
     FREE   → scrollTop += （视野顶那条内容被推下去多少）

   补偿量**不能**用 `newScrollHeight - oldScrollHeight`：那个差值把「末尾长高」
   也算进去了，而末尾长高时视野顶的内容一步没动 —— 照它补就是每来一段流式
   内容就把用户往下推一段（原始投诉的回头路）。要补的是锚点位移：末尾长高 → 0
   （不写），视野上方长高（展开上面的块 / 载入更早 / 上面的图片加载完）→ 正好
   等于长高量。两种情形都满足「视觉位置不动」。

   ── 程序滚动怎么和用户滚动区分 ──────────────────────────────
   程序写的落点记进 `writesRef`，scroll 事件落在其中一个上就认领、直接跳过
   （不按位置裁决）。认领表在「出现一次对不上的滚动」或「用户一动滚轮/键盘」
   时作废：既不能把用户的滚动算成程序的（那样用户滚到底也回不到 FOLLOW），
   也不能把程序的补偿算成用户的（那样 FREE 会被翻回 FOLLOW，真机复现过）。
   容器上还关了原生 `overflow-anchor`（它会偷偷改 scrollTop 且不带标记，
   那个 scroll 事件与用户滚动长得一模一样）。

   ── 锚点 ────────────────────────────────────────────────────
   锚点 = 浏览器命中测试得到的「视野顶那个元素」（`elementFromPoint`，取内容列
   水平中心；不支持时按 children 二分下钻）。折叠一个**跨在视野顶端**的块时，
   它和近处的兄弟一起被删 —— 所以锚点带的是一列备胎（往上取每层祖先的兄弟，
   永远兜到内容容器自己），位移照样等于「上面少了多少」（实现在 `lib/scrollAnchor`）。
   锚点只在 FREE 里有用：FOLLOW 不采集（`elementFromPoint` 会强制同步布局，
   而流式期间这个回调很密），进 FREE 那一刻（用户动手 / `enterFree`）再采。

   ── 剩下的实现规矩 ───────────────────────────────────────────
   全文件只有一个数字：BOTTOM_EPSILON = 4（规则 3 的「到真正的底」）。没有滞回、
   没有锁、没有 rAF 延迟清锁、没有「用户可能想干嘛」的猜测。切对话回来时位置
   先落到「当前能到的最大」，等真装得下再落到准确值（否则会被 clamp 成 0）。
   ══════════════════════════════════════════════════════════════ */

/** 判定「到真正的底」的容差（迁移规则 3）—— 全文件唯一的数字 */
export const BOTTOM_EPSILON = 4
/** 程序落点 / 锚点位移的比对容差（浏览器会把坐标抹成小数） */
const WRITE_EPSILON = 0.5

export interface AutoScroll {
  mode: ScrollMode
  /** 滚动容器的 callback ref（监听器挂这儿：容器可能晚挂载） */
  attachScroller: (node: HTMLDivElement | null) => void
  /** 内容容器的 callback ref（ResizeObserver 挂这儿） */
  attachContent: (node: HTMLDivElement | null) => void
  /** 迁移 5：回到底部 */
  enterFollow: () => void
  /** 迁移 4：用户动了布局 */
  enterFree: () => void
}

export function useAutoScroll(conversationId: string): AutoScroll {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  /* 意图放 ref（同步判定），state 只是给界面看的副本 */
  const modeRef = useRef<ScrollMode>('follow')
  const [mode, setMode] = useState<ScrollMode>('follow')
  /* 程序最近写过的落点（最近三个）：一帧里可能写两刀（补偿 + 贴底） */
  const writesRef = useRef<number[]>([])
  /* 锚点：视野顶那条内容、它的位置、以及「它被删了就用谁」的一列备胎 */
  const anchorRef = useRef<ScrollAnchor | null>(null)
  /* 最近一次已知的 scrollTop。切对话时**不能**去读 DOM：那一刻列表可能已经
     卸载（空对话先渲染开屏）—— ref 是 null，存下去的 0 会把位置抹掉（真机踩过）。 */
  const lastTopRef = useRef(0)
  /* 切对话时想恢复的位置（列表还没渲染完就先记着） */
  const pendingTopRef = useRef<number | null>(null)
  const conversationRef = useRef('')

  const applyMode = useCallback((next: ScrollMode): void => {
    if (modeRef.current === next) return
    modeRef.current = next
    setMode(next)
  }, [])

  /** 唯一的程序性写入口：记下落点，scroll 事件据此认领并跳过 */
  const writeTop = useCallback((el: HTMLDivElement, top: number): void => {
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    const next = Math.max(0, Math.min(top, max))
    writesRef.current = [next, ...writesRef.current].slice(0, 3)
    lastTopRef.current = next
    el.scrollTop = next
  }, [])

  /* ── 锚点：视野顶那条内容（FREE 的补偿量靠它算，实现在 lib/scrollAnchor）── */
  const captureAnchor = useCallback((): void => {
    const sc = scrollerRef.current
    const content = contentRef.current
    anchorRef.current = sc && content ? readAnchor(sc, content) : null
  }, [])

  const measureShift = useCallback((): number | null => {
    const sc = scrollerRef.current
    return sc ? anchorShift(sc, anchorRef.current) : null
  }, [])

  /* ── 内容变化：FOLLOW 贴底 / FREE 按锚点位移补偿 ── */
  const onResize = useCallback((): void => {
    const el = scrollerRef.current
    if (!el) return
    if (modeRef.current === 'follow') {
      /* 贴底不需要锚点 —— 那里不采集（`elementFromPoint` 会强制同步布局，
         而流式期间这个回调很密；锚点只在 FREE 里用，进 FREE 那一刻再采）。 */
      writeTop(el, el.scrollHeight)
      return
    }
    const pending = pendingTopRef.current
    if (pending !== null) {
      /* 切对话刚回来：先落到「当前能到的最大」，装得下就落准确值并结账 */
      writeTop(el, pending)
      if (pending <= el.scrollHeight - el.clientHeight + WRITE_EPSILON) pendingTopRef.current = null
      captureAnchor()
      return
    }
    const shift = measureShift()
    if (shift !== null && Math.abs(shift) > WRITE_EPSILON) writeTop(el, el.scrollTop + shift)
    /* 写完重新贴到（新的）视野顶 —— 锚点要一直是「视野里那一条」。
       锚点连同备胎全被这一刀删掉时（折叠跨视野顶端的块）也要重贴：
       否则基准一直无效，剩下的位移就没人补了（真机欠补 975px）。 */
    captureAnchor()
  }, [writeTop, captureAnchor, measureShift])

  const enterFollow = useCallback((): void => {
    const el = scrollerRef.current
    applyMode('follow')
    if (el) writeTop(el, el.scrollHeight)
  }, [applyMode, writeTop])

  const enterFree = useCallback((): void => {
    /* 用户刚动了布局（点开/折叠块）—— 先把锚点贴到**动作那一刻**的视野顶 */
    captureAnchor()
    applyMode('free')
  }, [applyMode, captureAnchor])

  /* ── 迁移 1/2/3：滚动落点裁决（滚轮、拖动条、PageDown、End 都走这儿）── */
  const onScroll = useCallback((): void => {
    const el = scrollerRef.current
    if (!el) return
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    /*
     * 浏览器把 scrollTop 钳回内容里（折叠、内容变矮）时**也会发一个 scroll 事件**，
     * 它和「用户滚到底」长得一模一样 —— 真机就是这么被翻回 FOLLOW 的：在底部点开
     * 一个块折叠它 → 钳到底 → 状态机以为用户滚到底 → 接下来一路贴底跟流（gap 恒 0）。
     * 分开它们只要一条算术事实：**上一个位置已经在新内容之外**，说明这一下是钳
     * 出来的（程序行为，迁移规则 3 只认用户；状态不变）。
     */
    const clamped = lastTopRef.current > max + WRITE_EPSILON
    lastTopRef.current = el.scrollTop
    const claimed = writesRef.current.some((v) => Math.abs(el.scrollTop - v) < WRITE_EPSILON)
    if (claimed) {
      if (modeRef.current === 'free') captureAnchor() /* 程序写的落点：状态不变 */
      return
    }
    /* 出现一次对不上的滚动 —— 程序那笔账作废，免得它一直吞用户的滚动 */
    writesRef.current = []
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (!clamped) applyMode(distance <= BOTTOM_EPSILON ? 'follow' : 'free')
    captureAnchor()
  }, [applyMode, captureAnchor])

  /* ── 迁移 1/2/3：滚轮最灵的那条（往上=立刻 FREE，不等 scroll 事件）── */
  const onWheel = useCallback(
    (event: WheelEvent): void => {
      writesRef.current = [] /* 用户一动手，程序那笔账立即作废 */
      const el = scrollerRef.current
      if (!el) return
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_EPSILON
      const next: ScrollMode = event.deltaY < 0 || !atBottom ? 'free' : 'follow'
      /* 进 FREE 的那一刻采锚点：之后每一刀都靠它算「视野上方少了/多了多少」 */
      if (next === 'free') captureAnchor()
      applyMode(next)
    },
    [applyMode, captureAnchor],
  )

  /* 键盘：向上键位直接 FREE；End 直接 FOLLOW；PageDown 交给随后的 scroll 事件裁决 */
  const onKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      writesRef.current = []
      if (event.key === 'PageUp' || event.key === 'Home') {
        captureAnchor()
        applyMode('free')
      } else if (event.key === 'End') applyMode('follow')
    },
    [applyMode, captureAnchor],
  )

  const attachScroller = useCallback(
    (node: HTMLDivElement | null): void => {
      const prev = scrollerRef.current
      if (prev && prev !== node) {
        prev.removeEventListener('scroll', onScroll)
        prev.removeEventListener('wheel', onWheel)
        prev.removeEventListener('keydown', onKeyDown)
      }
      scrollerRef.current = node
      if (!node) return
      lastTopRef.current = node.scrollTop
      node.addEventListener('scroll', onScroll, { passive: true })
      node.addEventListener('wheel', onWheel, { passive: true })
      node.addEventListener('keydown', onKeyDown)
      /* 挂上即就位：FOLLOW 贴底；FREE 把切走前的位置落回去（装不下就先落到最大） */
      if (modeRef.current === 'follow') writeTop(node, node.scrollHeight)
      else onResize()
      captureAnchor()
    },
    [onScroll, onWheel, onKeyDown, writeTop, captureAnchor, onResize],
  )

  const attachContent = useCallback(
    (node: HTMLDivElement | null): void => {
      observerRef.current?.disconnect()
      observerRef.current = null
      contentRef.current = node
      if (!node) return
      const ro = new ResizeObserver(() => onResize())
      ro.observe(node)
      observerRef.current = ro
      captureAnchor()
    },
    [onResize, captureAnchor],
  )

  /*
   * ── 切换对话（程序行为，不改状态；只做存/取）──
   * 存的是「用户显式选的意图」+ 那一刻的位置；切回来原样恢复。
   */
  useLayoutEffect(() => {
    const prevId = conversationRef.current
    if (prevId === conversationId) return
    conversationRef.current = conversationId
    const store = useScrollStore.getState()
    if (prevId) store.remember(prevId, { mode: modeRef.current, top: lastTopRef.current })
    const saved = conversationId ? store.byThread[conversationId] : undefined
    if (!saved || saved.mode === 'follow') {
      pendingTopRef.current = null
      enterFollow()
      return
    }
    applyMode('free')
    /* 位置先挂上：列表还没渲染出来（高度不够）时 onResize 会接着落 */
    pendingTopRef.current = saved.top
    onResize()
  }, [conversationId, applyMode, enterFollow, onResize])

  useEffect(() => {
    return () => observerRef.current?.disconnect()
  }, [])

  /*
   * 切对话回来时列表是分几拍渲染出来的（会话从磁盘读、渐增渲染），而
   * ResizeObserver 只在**尺寸变化**时报信。所以每次提交后再补一次落位尝试：
   * 装得下就落准确值，装不下就落到当前能到的最大 —— 位置不会丢成 0。
   */
  useLayoutEffect(() => {
    if (pendingTopRef.current !== null) onResize()
  })

  return { mode, attachScroller, attachContent, enterFollow, enterFree }
}
