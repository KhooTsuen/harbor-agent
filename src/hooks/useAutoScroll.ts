import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  anchorShift,
  readAnchor,
  readMessageAnchor,
  type MessageAnchor,
  type ScrollAnchor,
} from '@/lib/scrollAnchor'
import { WRITE_EPSILON } from '@/lib/scrollRestore'
import { useRestorePosition } from './useRestorePosition'
import { useScrollStore, type ScrollMode } from '@/stores/useScrollStore'

/* ══════════════════════════════════════════════════════════════
   自动滚动 —— 显式状态机，不做任何推断

   FOLLOW 看最新 / FREE 看历史，只由用户动作迁移（向上滚 / 没到底 → FREE，离底 ≤ 4px
   → FOLLOW）。FREE 的内容变化补「视野顶被推下去多少」；程序落点记进 writesRef 供
   scroll 认领；容器关掉 overflow-anchor。锚点见 lib/scrollAnchor / lib/scrollRestore。

   ★ 切回对话的落位必须**等窗口补完再写**（settleWindow）：窗口是一片片补的，
   目标一进窗口就落位的话，每补一片它上方就多一段内容，落点跟着变一次 ——
   连续写入看着就是「从下往上反复滑」，永远对不上。
   ══════════════════════════════════════════════════════════════ */

/** 判定「到真正的底」的容差（迁移规则 3）—— 全文件唯一的数字 */
export const BOTTOM_EPSILON = 4

/** 自己那条对话的记忆（切走时落盘用） */
type OwnMemory = { threadId: string; top: number; anchor: MessageAnchor | null }

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
  /** 把这次恢复改落到哪条消息（MessageList 扩窗到上限时用：落到窗口内最早那条，
   *  不为到位摊开整段历史，也不跳回最新处） */
  retarget: (anchor: MessageAnchor | null) => void
  /** 窗口补完了（MessageList 报）：此刻才允许写第一刀落点 */
  settleWindow: () => void
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
  /* 消息级锚点（切换对话用）：每次滚动 / 布局变化顺手记 —— 切走那一刻列表已卸载。
     ★ 必须带 threadId：新容器先挂上来，不带标就把 A 的记忆写成 B 的位置。 */
  const memRef = useRef<OwnMemory | null>(null)
  /* 最近一次已知的 scrollTop：切对话那一刻列表可能已卸载，读 DOM 会读到 0 把位置抹掉 */
  const lastTopRef = useRef(0)
  /* 「再试一次」要跑 onResize，而 onResize 又依赖 restore：用 ref 打断这个环 */
  const onResizeRef = useRef<() => void>(() => {})
  const conversationRef = useRef('')

  const applyMode = useCallback((next: ScrollMode): void => {
    if (modeRef.current === next) return
    modeRef.current = next
    setMode(next)
  }, [])

  /** 唯一的程序性写入口：记下落点，scroll 事件据此认领并跳过 */
  const writeTop = useCallback((el: HTMLDivElement, top: number): void => {
    /* 非有限值一个字节都不写：NaN 写进 scrollTop 之后所有几何读数都成 NaN，
       补偿就再也算不出来（真机表现为「卡在某个位置不动」） */
    if (!Number.isFinite(top)) return
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    const next = Math.max(0, Math.min(top, max))
    writesRef.current = [next, ...writesRef.current].slice(0, 3)
    lastTopRef.current = next
    el.scrollTop = next
  }, [])

  /* ── 锚点 ── */
  const captureAnchor = useCallback((): void => {
    const sc = scrollerRef.current
    const content = contentRef.current
    if (!sc || !content) return
    /* ★ 切对话的那次提交里**绝不**采集：conversationRef 还是旧的、DOM 已是新对话的，
       采下去就是把 B 的位置写成 A 的（真机表现「回来不是原来那里」）。 */
    if (conversationRef.current !== conversationId) return
    anchorRef.current = readAnchor(sc, content)
    /* 消息级锚点顺手更新（切走时 DOM 已经没了，只剩这份）。读不到就留上一次的。 */
    const anchor = readMessageAnchor(sc, content)
    const prev = memRef.current
    memRef.current = {
      threadId: conversationRef.current,
      top: sc.scrollTop,
      anchor: anchor ?? (prev?.threadId === conversationRef.current ? prev.anchor : null),
    }
  }, [conversationId])

  /* 落位判据与自重试都在 useRestorePosition；这里只把它接进状态机 */
  const restore = useRestorePosition({
    scroller: scrollerRef,
    content: contentRef,
    threadId: conversationId,
    write: writeTop,
    retry: () => onResizeRef.current(),
  })

  /* ── 内容变化：FOLLOW 贴底 / FREE 先补恢复，再按锚点位移补偿 ── */
  const onResize = useCallback((): void => {
    const el = scrollerRef.current
    if (!el) return
    if (modeRef.current === 'follow') {
      writeTop(el, el.scrollHeight)
      return
    }
    if (restore.pending.current) {
      restore.apply(el)
      /* 真的落定了才重贴锚点：没落定就采会把「还没回到位」当成新基准 */
      if (!restore.pending.current) captureAnchor()
      return
    }
    const shift = anchorShift(el, anchorRef.current)
    if (shift !== null && Math.abs(shift) > WRITE_EPSILON) writeTop(el, el.scrollTop + shift)
    /* 写完重贴到（新的）视野顶；锚点连备胎全被删掉时（折叠跨视野顶端的块）也要重贴，
       否则基准一直无效、剩下的位移没人补（真机欠补 975px） */
    captureAnchor()
  }, [writeTop, captureAnchor, restore])
  onResizeRef.current = onResize

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

  /** 恢复目标被窗口上限截断时改落点（只影响本次恢复，不动 store 里的真实记忆） */
  const retarget = restore.retarget

  /** 窗口补完了：现在写的第一刀才是真落点（早写会跟着每片长高往上滑） */
  const settleWindow = useCallback((): void => {
    restore.settle()
    if (restore.pending.current) onResize()
  }, [onResize, restore])

  /* ── 迁移 1/2/3：滚动落点裁决（滚轮、拖动条、PageDown、End 都走这儿）── */
  const onScroll = useCallback((): void => {
    const el = scrollerRef.current
    if (!el) return
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    /* 浏览器把 scrollTop 钳回内容里也会发 scroll 事件，它和「用户滚到底」长得一样
       （真机就这么被翻回 FOLLOW 过）。分开它们只要一条算术事实：上一个位置已经在
       新内容之外 —— 这一下是钳出来的（程序行为）。 */
    const clamped = lastTopRef.current > max + WRITE_EPSILON
    lastTopRef.current = el.scrollTop
    const claimed = writesRef.current.some((v) => Math.abs(el.scrollTop - v) < WRITE_EPSILON)
    if (claimed) {
      if (modeRef.current === 'free') captureAnchor() /* 程序写的落点：状态不变 */
      return
    }
    /* 出现一次对不上的滚动 —— 程序那笔账作废，免得它一直吞用户的滚动。
       这也算用户接管了视图：未完成的恢复立刻作废（不许再把他拉回旧位置）。 */
    writesRef.current = []
    restore.cancel()
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (!clamped) applyMode(distance <= BOTTOM_EPSILON ? 'follow' : 'free')
    captureAnchor()
  }, [applyMode, captureAnchor, restore])

  /* ── 迁移 1/2/3：滚轮最灵的那条（往上=立刻 FREE，不等 scroll 事件）── */
  const onWheel = useCallback(
    (event: WheelEvent): void => {
      writesRef.current = [] /* 用户一动手，程序那笔账立即作废 */
      restore.cancel() /* 同上：未完成的恢复也不许再拽他 */
      const el = scrollerRef.current
      if (!el) return
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_EPSILON
      const next: ScrollMode = event.deltaY < 0 || !atBottom ? 'free' : 'follow'
      /* 进 FREE 的那一刻采锚点：之后每一刀都靠它算「视野上方少了/多了多少」 */
      if (next === 'free') captureAnchor()
      applyMode(next)
    },
    [applyMode, captureAnchor, restore],
  )

  /* 键盘：向上键位直接 FREE；End 直接 FOLLOW；PageDown 交给随后的 scroll 事件裁决 */
  const onKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      writesRef.current = []
      restore.cancel() /* 键盘也是用户接管视图 */
      if (event.key === 'PageUp' || event.key === 'Home') {
        captureAnchor()
        applyMode('free')
      } else if (event.key === 'End') applyMode('follow')
    },
    [applyMode, captureAnchor, restore],
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
      node.addEventListener('scroll', onScroll, { passive: true })
      node.addEventListener('wheel', onWheel, { passive: true })
      node.addEventListener('keydown', onKeyDown)
      /* ★ 正在切对话（ref 阶段早于 layout effect）：这一刻的容器已经是**新对话**的，
         在上面写位置 / 采锚点会把旧对话的记忆写成新对话的 —— 交给 layout effect 接管 */
      if (conversationRef.current !== conversationId) return
      lastTopRef.current = node.scrollTop
      /* 挂上即就位：FOLLOW 贴底；FREE 把切走前的位置落回去（装不下就先落到最大）。
         ★ 恢复还在挂起时**不许**贴底：那会先跳到底再往上找，正是「从下往上滑」 */
      if (modeRef.current === 'follow' && !restore.pending.current)
        writeTop(node, node.scrollHeight)
      else onResize()
      captureAnchor()
    },
    [onScroll, onWheel, onKeyDown, writeTop, captureAnchor, onResize, conversationId],
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
      /* 同 attachScroller：切换中的新内容容器不采集（那是另一条对话的 DOM） */
      if (conversationRef.current === conversationId) captureAnchor()
    },
    [onResize, captureAnchor, conversationId],
  )

  /* ── 切换对话：存「意图 + 消息锚点 + 像素」，取自己那份等窗口盖住目标才落位。
     ★ 只认带 prevId 标签的记忆：新容器的 ref 早于本 effect，没标签可能把 B 当 A 存。 */
  useLayoutEffect(() => {
    const prevId = conversationRef.current
    if (prevId === conversationId) return
    conversationRef.current = conversationId
    const store = useScrollStore.getState()
    const own = memRef.current?.threadId === prevId ? memRef.current : null
    /* 拿不到自己那份就不写 —— 保留 store 里上一次离开时的记忆，比写错强 */
    if (prevId && own)
      store.remember(prevId, { mode: modeRef.current, top: own.top, anchor: own.anchor })
    /* 旧对话的恢复任务、锚点、定时器全扔 —— 串到新对话上就是「把 A 的位置用到 B」。
       reset 会同时把 ready 关掉：等 MessageList 把窗口盖住目标才允许写 */
    restore.reset()
    memRef.current = null
    lastTopRef.current = 0
    const saved = conversationId ? store.byThread[conversationId] : undefined
    if (!saved || saved.mode !== 'free') {
      /* 离开时在跟最新：回来继续跟最新（不把所有对话都拽到历史位置） */
      enterFollow()
      return
    }
    applyMode('free')
    /* 落点先挂上：窗口还没盖住目标时 onResize 不写，等 settleWindow 放行 */
    restore.arm({ threadId: conversationId, anchor: saved.anchor, top: saved.top })
    onResize()
  }, [conversationId, applyMode, enterFollow, onResize, restore])

  useEffect(() => {
    return () => observerRef.current?.disconnect()
  }, [])

  /* 切对话回来时列表是分几拍渲染的（会话从磁盘读 + 渐增渲染），而 ResizeObserver
     只在尺寸变化时报信。所以每次提交后再补一次落位尝试：目标没进窗口就等。 */
  useLayoutEffect(() => {
    if (restore.pending.current) onResize()
  })

  return { mode, attachScroller, attachContent, enterFollow, enterFree, retarget, settleWindow }
}
