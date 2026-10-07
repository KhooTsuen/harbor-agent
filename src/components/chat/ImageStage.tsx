import { useCallback, useRef, useState } from 'react'
import type { MouseEvent, PointerEvent, WheelEvent } from 'react'
import { clampScale, useImageLightbox } from '@/stores/useImageLightbox'

/* ══════════════════════════════════════════════════════════════
   图片本体：拖动看局部 + 滚轮以鼠标为中心缩放

   跟 `ImageLightbox.tsx`（外壳：遮罩、键盘、工具条）拆开，是因为外壳
   加完那些按钮就蹭到 300 行红线了，而这块的交互（指针捕获、坐标换算）
   本来就自成一摊。

   ★ 遮罩那两层半透明黑留在 ImageLightbox.tsx：那个文件进了 themePrimer
     的白名单（「中性遮罩，无主题语义」），把遮罩样式挪到这里会被硬编码
     颜色扫描报红。
   ══════════════════════════════════════════════════════════════ */

/** 滚轮每一格的缩放倍率（触控板那种细密滚动也按格算，够跟手） */
const WHEEL_STEP = 1.12
/** 位移超过这么多像素就算「拖过」，用来吞掉拖完松手那一下的 click */
const DRAG_SLOP = 3

export function ImageStage({ src }: { src: string }) {
  const scale = useImageLightbox((s) => s.scale)
  const tx = useImageLightbox((s) => s.tx)
  const ty = useImageLightbox((s) => s.ty)
  const rotation = useImageLightbox((s) => s.rotation)
  const actualSize = useImageLightbox((s) => s.actualSize)
  const setView = useImageLightbox((s) => s.setView)
  const reset = useImageLightbox((s) => s.reset)

  const box = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  /** 拖拽起点：按下那一刻的指针位置 + 当时的平移量 */
  const from = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const moved = useRef(false)

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      from.current = { x: event.clientX, y: event.clientY, tx, ty }
      moved.current = false
      setDragging(true)
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [tx, ty],
  )

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const start = from.current
      if (!start) return
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      if (Math.abs(dx) + Math.abs(dy) > DRAG_SLOP) moved.current = true
      setView({ tx: start.tx + dx, ty: start.ty + dy })
    },
    [setView],
  )

  const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    from.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  /** 拖完松手那一下别当成「点了背景」把查看器关掉 */
  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!moved.current) return
    moved.current = false
    event.stopPropagation()
  }, [])

  /* 以鼠标位置为中心缩放：光标底下那个点，缩放前后应该待在原地 */
  const onWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      event.preventDefault()
      const rect = box.current?.getBoundingClientRect()
      if (!rect) return
      const next = clampScale(scale * (event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP))
      const ratio = next / scale
      const px = event.clientX - (rect.left + rect.width / 2)
      const py = event.clientY - (rect.top + rect.height / 2)
      setView({ scale: next, tx: px - (px - tx) * ratio, ty: py - (py - ty) * ratio })
    },
    [scale, tx, ty, setView],
  )

  return (
    <div
      ref={box}
      className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        className={[
          'select-none object-contain',
          actualSize ? 'max-h-none max-w-none' : 'max-h-full max-w-full',
          dragging ? 'cursor-grabbing' : scale > 1 ? 'cursor-grab' : 'cursor-default',
          dragging ? '' : 'transition-transform duration-fast',
        ].join(' ')}
        style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale}) rotate(${rotation}deg)` }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={reset}
      />
    </div>
  )
}
