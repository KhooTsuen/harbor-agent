import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { MessageAnchor } from '@/lib/scrollAnchor'
import { restoreStep, type PendingRestore } from '@/lib/scrollRestore'

/* ══════════════════════════════════════════════════════════════
   「切回对话的那一次落位」—— 挂起、重试、作废

   从 `useAutoScroll` 拆出来（那边贴 300 行红线）：滚动状态机管的是**平时**怎么滚，
   这里管的是**切回来那一次**怎么落到原来的行上。两者只是共用同一个写入口。

   三件事：
     · arm —— 挂上要恢复的锚点（窗口还没盖住目标时 onResize 一个字节都不写）
     · apply —— 试一次落位；判据全在 lib/scrollRestore（wait / done / stale）
     · cancel —— 用户一动手 / 切对话 / 卸载就作废，绝不许它回头拽用户

   ★ 为什么要自重试：「等」有两种 —— 目标还没进窗口（MessageList 扩窗后会有新提交），
   或者目标已经在了、但这一帧还没有高度（图片 / 懒内容 / 刚落进 DOM）。后一种之后
   可能再也没有任何提交或 ResizeObserver 报信 —— 真机就是「回来了却没落位」，
   测试里是「一刀都没写」。所以自己再敲几次门：判据仍是「对上才写」。
   ══════════════════════════════════════════════════════════════ */

/** 一帧 ≈ 16ms；60 次 ≈ 1 秒，超过就交给 ResizeObserver / 下一次提交 */
const RETRY_MS = 16
const RETRY_LIMIT = 60

export interface RestorePosition {
  /** 挂着的恢复（只归它自己那条对话用） */
  pending: RefObject<PendingRestore | null>
  /** 窗口是否已经盖住目标：false 时一个字节都不写 */
  ready: RefObject<boolean>
  /** 切对话时调：清挂起 + 停重试 + 重新等窗口 */
  reset: () => void
  /** 把要恢复的位置挂上 */
  arm: (pending: PendingRestore) => void
  /** 目标改口（被删 / 超出窗口上限），只影响本次恢复 */
  retarget: (anchor: MessageAnchor | null) => void
  /** 试一次落位（内容变化 / 每次提交后 / 重试） */
  apply: (el: HTMLDivElement) => void
  /** 窗口已经盖住目标：放行第一刀 */
  settle: () => void
  /** 作废：用户接管视图、切对话、卸载 */
  cancel: () => void
}

export function useRestorePosition(opts: {
  scroller: RefObject<HTMLDivElement | null>
  content: RefObject<HTMLElement | null>
  threadId: string
  write: (el: HTMLDivElement, top: number) => void
  /** 「再试一次」要跑的那条（useAutoScroll 传 onResize） */
  retry: () => void
}): RestorePosition {
  const { scroller, content, threadId, write } = opts
  const pending = useRef<PendingRestore | null>(null)
  const ready = useRef(false)
  const tries = useRef(0)
  const timer = useRef<number | null>(null)
  /* retry 每轮都是新的闭包：放 ref 里读最新的那个，免得 apply 的依赖天天变 */
  const retryRef = useRef(opts.retry)
  retryRef.current = opts.retry

  /* 作废：把挂起的那次恢复也扔掉 —— 用户接管视图之后不许它再回头拽 */
  const cancel = useCallback((): void => {
    pending.current = null
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    tries.current = 0
  }, [])

  const apply = useCallback(
    (el: HTMLDivElement): void => {
      const target = pending.current
      if (!target || !ready.current) return
      const outcome = restoreStep(el, content.current, target, threadId, (top) => write(el, top))
      if (outcome !== 'wait') {
        pending.current = null
        tries.current = 0
        return
      }
      if (tries.current >= RETRY_LIMIT) return
      tries.current += 1
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => retryRef.current(), RETRY_MS)
    },
    [content, threadId, write],
  )

  const reset = useCallback((): void => {
    cancel()
    ready.current = false
  }, [cancel])

  const arm = useCallback((next: PendingRestore): void => {
    pending.current = next
    tries.current = 0
  }, [])

  const settle = useCallback((): void => {
    ready.current = true
  }, [])

  const retarget = useCallback((anchor: MessageAnchor | null): void => {
    const cur = pending.current
    if (cur) pending.current = { ...cur, anchor }
  }, [])

  /* 卸载时定时器必须停：它攥着旧容器的闭包，跑起来就是往一个卸掉的节点上写 */
  useEffect(() => cancel, [cancel])

  /* scroller 只是给调用方对齐口径用的（判据里要读它的几何），这里不需要单独用 */
  void scroller
  return { pending, ready, reset, arm, retarget, apply, cancel, settle }
}
