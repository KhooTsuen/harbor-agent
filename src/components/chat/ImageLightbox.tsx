import { useCallback, useEffect } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderOpen,
  Maximize2,
  Minus,
  Plus,
  RotateCw,
  Save,
  X,
} from 'lucide-react'
import { useImageLightbox } from '@/stores/useImageLightbox'
import { useUIStore } from '@/stores/useUIStore'
import { IconButton } from '@/components/ui/IconButton'
import { ImageStage } from './ImageStage'

/* ══════════════════════════════════════════════════════════════
   图片查看器（lightbox）—— 外壳

   点开对话里的图片 → 全屏看大图：
     · 滚轮 / + / -     放大缩小（0.2x ~ 8x，缩放范围在 useImageLightbox）
     · 按住拖动          看放大后的任意角落（在 ImageStage 里）
     · 双击 / 0          回到「适应窗口 + 居中」
     · 适应窗口 / 1:1    在「适应窗口」和「原始像素」之间切
     · 旋转              每次 90°
     · 另存为 / 在文件夹里显示 / 复制到剪贴板（走主进程，见 handlers/image-file.cjs）
     · ← → / 两侧箭头    切上一张 / 下一张（在当前对话内的图片之间）
     · Esc / 点背景 / ×  关闭

   ★ 这个文件里有 `bg-black/85`（遮罩）和 `bg-black/60`（工具条），是
     themePrimer 白名单里的「中性遮罩，无主题语义」—— 别挪去别的文件。
   ══════════════════════════════════════════════════════════════ */

/** 三个「跟系统打交道」的动作长得一样，抽出来免得抄三遍 try/catch + toast */
async function runFileAction(
  action: () => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>,
  doneTitle: string,
): Promise<void> {
  const toast = useUIStore.getState().showToast
  try {
    const result = await action()
    if (result.canceled) return
    if (result.ok) toast('success', doneTitle, result.path)
    else toast('error', '没做成', result.error)
  } catch (error) {
    toast('error', '没做成', error instanceof Error ? error.message : String(error))
  }
}

export function ImageLightbox() {
  const images = useImageLightbox((s) => s.images)
  const index = useImageLightbox((s) => s.index)
  const scale = useImageLightbox((s) => s.scale)
  const actualSize = useImageLightbox((s) => s.actualSize)
  const close = useImageLightbox((s) => s.close)
  const next = useImageLightbox((s) => s.next)
  const prev = useImageLightbox((s) => s.prev)
  const zoom = useImageLightbox((s) => s.zoom)
  const reset = useImageLightbox((s) => s.reset)
  const rotate = useImageLightbox((s) => s.rotate)
  const setActualSize = useImageLightbox((s) => s.setActualSize)

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
        case 'r':
        case 'R':
          rotate(90)
          break
        case '0':
          reset()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [images.length, close, next, prev, zoom, reset, rotate])

  /** 桌面版才有这三条通道；浏览器预览里点它们只会让人以为坏了 */
  const fileAction = useCallback(
    (method: 'imageSaveAs' | 'imageReveal' | 'imageCopy', doneTitle: string) => () => {
      const bridge = window.workbench
      if (!bridge) {
        useUIStore.getState().showToast('error', '这个功能要在桌面版里用')
        return
      }
      void runFileAction(() => bridge[method](images[index] ?? ''), doneTitle)
    },
    [images, index],
  )

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
      <ImageStage src={images[index] ?? ''} />

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
        className="absolute bottom-5 flex items-center gap-2 rounded-full bg-black/60 px-4 py-2 text-fg-primary"
        onClick={(event) => event.stopPropagation()}
      >
        <IconButton label="缩小" size={28} onClick={() => zoom(-0.25)}>
          <Minus size={16} />
        </IconButton>
        <span className="w-14 text-center font-mono text-xs">{Math.round(scale * 100)}%</span>
        <IconButton label="放大" size={28} onClick={() => zoom(0.25)}>
          <Plus size={16} />
        </IconButton>

        <span className="mx-1 h-5 w-px bg-fg-secondary/30" />

        <IconButton
          label="适应窗口"
          hint="适应窗口（双击图片也行）"
          size={28}
          active={!actualSize}
          onClick={reset}
        >
          <Maximize2 size={15} />
        </IconButton>
        <IconButton
          label="原始大小"
          hint="按原始像素显示（1:1）"
          size={28}
          active={actualSize}
          onClick={() => setActualSize(!actualSize)}
        >
          <span className="font-mono text-[10px] leading-none">1:1</span>
        </IconButton>
        <IconButton label="旋转 90°" hint="顺时针转 90°（R）" size={28} onClick={() => rotate(90)}>
          <RotateCw size={15} />
        </IconButton>

        <span className="mx-1 h-5 w-px bg-fg-secondary/30" />

        <IconButton
          label="另存为"
          hint="另存为（存到电脑上）"
          size={28}
          onClick={fileAction('imageSaveAs', '图片已保存')}
        >
          <Save size={15} />
        </IconButton>
        <IconButton
          label="在文件夹里显示"
          size={28}
          onClick={fileAction('imageReveal', '已在文件夹里定位')}
        >
          <FolderOpen size={15} />
        </IconButton>
        <IconButton label="复制图片" size={28} onClick={fileAction('imageCopy', '已复制到剪贴板')}>
          <Copy size={15} />
        </IconButton>

        {multiple ? (
          <span className="ml-1 font-mono text-xs text-fg-secondary">
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
