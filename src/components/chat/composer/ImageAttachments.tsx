import { ImageIcon, X } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { useThreadStore } from '@/stores/useThreadStore'

/* ══════════════════════════════════════════════════════════════
   待发送图片的预览条

   贴在输入框上方。图片以 data URL 存着（不落盘），发出去就清空。

   抽成组件是因为 Composer 已经贴着 300 行 —— 它现在只管
   「什么时候加图片」，不管「图片长什么样」。
   ══════════════════════════════════════════════════════════════ */

export function ImageAttachments() {
  const images = useThreadStore((s) => s.inputImages)
  const remove = useThreadStore((s) => s.removeInputImage)

  if (images.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2 px-1 pb-1.5">
      {images.map((src, index) => (
        <div
          key={src.slice(-32)}
          className="group relative size-16 overflow-hidden rounded-base border border-line-hairline"
        >
          <img src={src} alt={`待发送的图片 ${index + 1}`} className="size-full object-cover" />
          <div className="absolute inset-0 flex items-start justify-end bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
            <IconButton
              label="移除这张图"
              size={28}
              onClick={() => remove(index)}
              className="m-0.5"
            >
              <X size={12} />
            </IconButton>
          </div>
        </div>
      ))}
      <span className="flex items-center gap-1 text-2xs text-fg-tertiary">
        <ImageIcon size={11} />
        {images.length} 张 · 会一起发给模型
      </span>
    </div>
  )
}
