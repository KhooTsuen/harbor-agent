import { useEffect, type RefObject } from 'react'
import { renderRing } from './ringRotator'

/** 转满一圈的时长；和之前保持一致，只是现在按屏幕刷新率逐帧重绘 */
const ROTATION_MS = 12_000

/**
 * 逐帧重绘 <pre> 的文本。
 *
 * 直接改 textContent 而不是 setState：每秒 60 次 React 渲染会把整棵组件树
 * 拖下水，而这里只有一段文本需要变。
 */
export function useBannerAnimation(ringRef: RefObject<HTMLPreElement | null>): void {
  useEffect(() => {
    const ring = ringRef.current
    if (!ring) return

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
    let animationFrame = 0
    let angle = 0
    let previousTime: number | null = null

    const paint = (degrees: number): void => {
      ring.textContent = renderRing(degrees)
    }

    const step = (now: number): void => {
      if (previousTime !== null) angle += ((now - previousTime) / ROTATION_MS) * 360
      previousTime = now
      paint(angle % 360)
      animationFrame = requestAnimationFrame(step)
    }

    const sync = (): void => {
      cancelAnimationFrame(animationFrame)
      previousTime = null
      if (document.hidden || reducedMotion.matches) {
        /* 静态时也保留当前角度，别留一片空白 */
        paint(angle % 360)
        return
      }
      animationFrame = requestAnimationFrame(step)
    }

    paint(0)
    sync()
    document.addEventListener('visibilitychange', sync)
    reducedMotion.addEventListener('change', sync)
    return () => {
      cancelAnimationFrame(animationFrame)
      document.removeEventListener('visibilitychange', sync)
      reducedMotion.removeEventListener('change', sync)
    }
  }, [ringRef])
}
