import { useCallback, useEffect, useState } from 'react'

/* ══════════════════════════════════════════════════════════════
   元素自身的宽度（CSS px）—— P3 #18 用

   为什么不复用 `useWindowWidth`：那个量的是**窗口**。而右栏标签栏挤不挤
   只取决于**右栏自己的宽度**（右栏可拖宽 320–720，窗口不变时它也在变）。
   拿窗口宽度去判断，会在「窗口很宽但右栏被拖窄」时判错 —— 那正是最容易
   挤成竖排单字的情形。

   ── 两条口径（2026-10-20 修的）──────────────────────────────

   ① **首测必须在 ref 回调里同步做，不能等 effect。**
      以前初始 state 是 0 → 调用方按「窄」渲染 → effect 里才量到真值。
      宽右栏上就会**先闪一下窄档再变宽**（打开应用、展开右栏时肉眼可见）。
      ref 回调发生在 commit 阶段、paint 之前，在那里 setState 会在同一帧内
      重渲染，用户看不到那一跳。

   ② **首测与 ResizeObserver 必须同一个口径。**
      以前首测用 `getBoundingClientRect().width`（含 padding），RO 用
      `contentRect.width`（不含 padding）—— 两者差一个 `px-1.5`（12px）。
      对「宽度 >= 门槛」这种判据，这 12px 正好卡在临界点上，会来回抖一下。
      现在统一用 `clientWidth`（含 padding、不含 border），拖宽时口径不跳。
   ══════════════════════════════════════════════════════════════ */

/** 读一个元素的可用宽度（含 padding，不含边框）—— 本文件的唯一口径 */
function widthOf(node: HTMLElement | null): number {
  return node ? node.clientWidth : 0
}

export function useElementWidth<T extends HTMLElement>(): {
  ref: (node: T | null) => void
  width: number
} {
  const [node, setNode] = useState<T | null>(null)
  const [width, setWidth] = useState(0)

  /* 值没变不 setState：RO 在别处也会触发，没必要多渲一次 */
  const push = useCallback((next: number): void => {
    setWidth((prev) => (Math.abs(next - prev) < 1 ? prev : next))
  }, [])

  /* ★ 首测同步（口径见文件头 ①）—— 所以初始渲染就拿得到真值 */
  const ref = useCallback(
    (next: T | null) => {
      setNode(next)
      if (next) push(widthOf(next))
    },
    [push],
  )

  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      /* 取最后一次：一帧内多次通知时，最后那个才是当前尺寸 */
      const last = entries[entries.length - 1]
      if (!last) return
      push(widthOf(last.target as HTMLElement))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, push])

  return { ref, width }
}
