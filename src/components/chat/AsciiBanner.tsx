import { useLayoutEffect, useRef } from 'react'
import { useBannerAnimation } from './useBannerAnimation'

/* ══════════════════════════════════════════════════════════════
   空对话时的装饰横幅（Aperture 标志，ASCII）

   图是 498 字符宽 × 62 行 —— **一换行整个图就散架**，
   所以字号不能写死，必须按容器宽度反推：

     ① 先把字号设成 100px，量一次「整段有多宽」
     ② 按容器实际宽度等比缩小

   不猜「等宽字符宽 = 0.6em」是因为不同字体不一样，
   量出来才准（这也让它在任何宽度下都刚好铺满、不留横向滚动条）。

   纯装饰：`aria-hidden`，屏幕阅读器不用念这一堆 @。
   ══════════════════════════════════════════════════════════════ */

export function AsciiBanner() {
  const art = useBannerAnimation()
  const wrapRef = useRef<HTMLDivElement>(null)
  const preRef = useRef<HTMLPreElement>(null)

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const pre = preRef.current
    if (!wrap || !pre) return

    const fit = (): void => {
      const available = wrap.clientWidth
      if (!available) return
      pre.style.fontSize = '100px'
      const width = pre.scrollWidth
      if (!width) {
        pre.style.fontSize = ''
        return
      }
      pre.style.fontSize = `${(100 * available) / width}px`
    }

    fit()
    /* 窗口/面板宽度变了要重算 */
    const observer = new ResizeObserver(fit)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={wrapRef} className="w-full max-w-3xl overflow-hidden" aria-hidden="true">
      <pre
        ref={preRef}
        data-ascii="banner"
        /* leading-none：62 行，行距一大图就被拉长变形 */
        className="m-0 whitespace-pre font-mono leading-none text-fg-primary"
      >
        {art}
      </pre>
    </div>
  )
}
