import { useEffect } from 'react'
import { Minus, Plus, RotateCcw, X, ChevronLeft, ChevronRight } from 'lucide-react'
import { useImageLightbox } from '@/stores/useImageLightbox'
import { IconButton } from '@/components/ui/IconButton'

/* ══════════════════════════════════════════════════════════════
   图片查看器（lightbox）

   点开对话里的图片 → 全屏看大图。基础功能：
     · 滚轮 / + / -  放大缩小（0.2x ~ 8x）
     · 双击 / 0      回到原始大小
     · ← → / 两侧箭头  切上一张 / 下一张（在当前对话内的图片之间）
     · Esc / 点背景 / ×  关闭
   ══════════════════════════════════════════════════════════════ */

export function ImageLightbox() {
  const images = useImageLightbox((s) => s.images)
  const index = useImageLightbox((s) => s.index)
  const scale = useImageLightbox((s) => s.scale)
  const close = useImageLightbox((s) => s.close)
  const next = useImageLightbox((s) => s.next)
  const prev = useImageLightbox((s) => s.prev)
  const zoom = useImageLightbox((s) => s.zoom)
  const reset = useImageLightbox((s) => s.reset)

  /* 键盘操作 —— 关掉后要记得卸载监听 */
  useEffect(() => {
    if (images.length === 0) return
    const onKey = (event: KeyboardEvent): void => {
      switch (event.key) {
        case 'Escape':
          close()
          break
        case 'ArrowLeft':
          prev()
          break
        case 'ArrowRight':
          next()
          break
        case '+':
        case '=':
          zoom(0.25)
          break
        case '-':
          zoom(-0.25)
          break
        case '0':
          reset()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [images.length, close, next, prev, zoom, reset])

  if (images.length === 0) return null

  const multiple = images.length > 1

  return (
    /* 背景：点一下关闭 */
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/85"
      onClick={close}
      role="dialog"
      aria-label="图片查看器"
    >
      {/* 图片本体：滚轮缩放、双击复位、点击不关闭 */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <img
          src={images[index]}
          alt=""
          draggable={false}
          className="max-h-full max-w-full object-contain transition-transform duration-fast"
          style={{ transform: `scale(${scale})` }}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={reset}
          onWheel={(event) => {
            event.preventDefault()
            zoom(event.deltaY < 0 ? 0.25 : -0.25)
          }}
        />
      </div>

      {/* 左右切换 */}
      {multiple ? (
        <>
          <IconButton
            label="上一张"
            size={36}
            className="absolute left-4 top-1/2 -translate-y-1/2"
            onClick={(event) => {
              event.stopPropagation()
              prev()
            }}
          >
            <ChevronLeft size={24} />
          </IconButton>
          <IconButton
            label="下一张"
            size={36}
            className="absolute right-4 top-1/2 -translate-y-1/2"
            onClick={(event) => {
              event.stopPropagation()
              next()
            }}
          >
            <ChevronRight size={24} />
          </IconButton>
        </>
      ) : null}

      {/* 底部工具条 */}
      <div
        className="absolute bottom-5 flex items-center gap-3 rounded-full bg-black/60 px-4 py-2 text-fg-primary"
        onClick={(event) => event.stopPropagation()}
      >
        <IconButton label="缩小" size={28} onClick={() => zoom(-0.25)}>
          <Minus size={16} />
        </IconButton>
        <span className="w-14 text-center font-mono text-xs">{Math.round(scale * 100)}%</span>
        <IconButton label="放大" size={28} onClick={() => zoom(0.25)}>
          <Plus size={16} />
        </IconButton>
        <IconButton label="还原大小" size={28} onClick={reset}>
          <RotateCcw size={15} />
        </IconButton>
        {multiple ? (
          <span className="font-mono text-xs text-fg-secondary">
            {index + 1} / {images.length}
          </span>
        ) : null}
      </div>

      {/* 关闭 */}
      <IconButton label="关闭" size={36} className="absolute right-4 top-4" onClick={close}>
        <X size={20} />
      </IconButton>
    </div>
  )
}
