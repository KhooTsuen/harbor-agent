import { useLayoutEffect, useRef } from 'react'
import { useBannerAnimation } from './useBannerAnimation'
import wordmark from '@/assets/banner/wordmark.txt?raw'

/* ══════════════════════════════════════════════════════════════
   空对话时的装饰横幅（Aperture 标志，ASCII）

   三层，从下往上：

     ① 光圈        —— 每帧实时生成 ASCII，60 FPS 转转停停都在这一层
     ② 遮罩        —— 沿字母 A 左边那条斜边切一刀，挡住底下透上来的叶片
     ③ 前景字样    —— 原始字样，固定不动

   遮罩那一层的斜度是照着字母 A 左边缘量出来的：A 的左边从顶部第 121 列
   斜到底部第 97 列，所以遮罩左边界取 50% → 4%（相对遮罩自身宽度）正好贴住。
   少了它，旋转的叶片会从 A 的笔缝里透出来。

   字号不写死：先把字号设成 100px 量一次整段宽度，再按容器宽度等比缩小。
   等宽字符的实际宽度依字体而定，量出来才准。
   ══════════════════════════════════════════════════════════════ */

export function AsciiBanner() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<HTMLPreElement>(null)
  useBannerAnimation(ringRef)

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const stage = stageRef.current
    if (!wrap || !stage) return

    const fit = (): void => {
      if (!wrap.clientWidth) return
      stage.style.fontSize = '100px'
      if (!stage.scrollWidth) return
      stage.style.fontSize = `${(100 * wrap.clientWidth) / stage.scrollWidth}px`
    }

    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={wrapRef} className="w-full max-w-3xl overflow-hidden" aria-hidden="true">
      <div ref={stageRef} className="relative w-max font-mono leading-none text-fg-primary">
        <pre
          ref={ringRef}
          data-ascii-ring="animated"
          className="absolute left-0 top-0 z-0 m-0 whitespace-pre font-inherit leading-inherit"
        />
        <div
          data-ascii-mask="a"
          className="pointer-events-none absolute z-10 bg-bg-base"
          style={{
            left: '95ch',
            top: '17em',
            width: '52ch',
            height: '23em',
            clipPath: 'polygon(50% 0, 100% 0, 100% 100%, 4% 100%)',
          }}
        />
        <pre
          data-ascii="banner"
          className="relative z-20 m-0 whitespace-pre font-inherit leading-inherit"
        >
          {wordmark}
        </pre>
      </div>
    </div>
  )
}
