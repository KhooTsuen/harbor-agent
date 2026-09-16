import { create } from 'zustand'

/* ══════════════════════════════════════════════════════════════
   图片查看器（lightbox）的状态

   点开对话里的图片 → 全屏查看，能放大缩小、在对话内的图片之间切换。
   ══════════════════════════════════════════════════════════════ */

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

interface ImageLightboxState {
  /** 当前对话里能切换的所有图片 */
  images: string[]
  index: number
  /** 缩放倍数（1 = 原始大小） */
  scale: number
  open: (images: string[], index: number) => void
  close: () => void
  next: () => void
  prev: () => void
  zoom: (delta: number) => void
  reset: () => void
}

export const useImageLightbox = create<ImageLightboxState>((set) => ({
  images: [],
  index: 0,
  scale: 1,

  open: (images, index) => set({ images, index, scale: 1 }),
  close: () => set({ images: [], index: 0, scale: 1 }),

  /* 切换图片时把缩放也归位，不然下一张还停在上一张的放大倍数会很突兀 */
  next: () =>
    set((s) => (s.images.length === 0 ? s : { index: (s.index + 1) % s.images.length, scale: 1 })),
  prev: () =>
    set((s) =>
      s.images.length === 0
        ? s
        : { index: (s.index - 1 + s.images.length) % s.images.length, scale: 1 },
    ),

  zoom: (delta) => set((s) => ({ scale: clamp(s.scale + delta, 0.2, 8) })),
  reset: () => set({ scale: 1 }),
}))

/** 从 DOM 收集当前对话里所有图片并打开 —— 见 Inline.tsx 的调用处 */
export function openImageFromDom(src: string): void {
  const all = [...document.querySelectorAll('[data-chat-image]')]
    .map((el) => el.getAttribute('src'))
    .filter((value): value is string => Boolean(value))
  /* 去重，保持先后顺序 */
  const images = [...new Set(all)]
  const index = Math.max(0, images.indexOf(src))
  useImageLightbox.getState().open(images, index)
}
