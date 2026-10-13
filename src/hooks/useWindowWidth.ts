import { useEffect, useState } from 'react'

/* ══════════════════════════════════════════════════════════════
   窗口内宽（CSS px）

   用途：右栏宽度上限要按「窗口实际余量」算（见 `lib/layoutWidth.ts`），
   所以需要一个会随窗口变化的宽度值。

   两条纪律：
     · **rAF 节流**：拖窗口边缘时 `resize` 一秒能来上百次，逐次 setState
       会让三栏一起重排 —— 一帧一次就够（React 本来也是按帧渲染）。
     · **值没变不 setState**：`resize` 也会在别的场合触发，值相同就直接返回，
       免得多余重渲（同 `useRootFontScale` 的写法）。
   ══════════════════════════════════════════════════════════════ */

/** 读当前窗口内宽；非浏览器环境返回 0（调用方按「拿不到」保守处理） */
export function readWindowWidth(): number {
  if (typeof window === 'undefined') return 0
  return window.innerWidth || 0
}

export function useWindowWidth(): number {
  const [width, setWidth] = useState<number>(() => readWindowWidth())

  useEffect(() => {
    let frame = 0

    const update = (): void => {
      frame = 0
      setWidth((prev) => {
        const next = readWindowWidth()
        return next === prev ? prev : next
      })
    }

    const onResize = (): void => {
      if (frame) return
      frame = requestAnimationFrame(update)
    }

    /* 挂载时先校一次：初始化与真实值之间可能已经变过 */
    update()
    window.addEventListener('resize', onResize)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return width
}
