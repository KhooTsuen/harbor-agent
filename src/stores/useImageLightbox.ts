import { create } from 'zustand'

/* ══════════════════════════════════════════════════════════════
   图片查看器（lightbox）的状态

   点开对话里的图片 → 全屏查看：缩放、拖动看局部、旋转、在对话内的
   图片之间切换。

   ★ 缩放范围写在这里一处，渲染层的滚轮缩放也从这里取 ——
     两边各写一套的话「按钮能到 8x、滚轮只能到 5x」这种就会来。
   ══════════════════════════════════════════════════════════════ */

export const MIN_SCALE = 0.2
export const MAX_SCALE = 8

export function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

/** 换图 / 关闭时的观感复位（旋转也跟着回正，不然切过去还是歪的） */
const FRESH = { scale: 1, tx: 0, ty: 0, rotation: 0, actualSize: false }

interface ImageLightboxState {
  /** 当前对话里能切换的所有图片 */
  images: string[]
  index: number
  /** 缩放倍数（1 = 适应窗口的大小） */
  scale: number
  /** 平移量（像素，相对居中位置）—— 放大后拖出去的那部分 */
  tx: number
  ty: number
  /** 旋转角度（度，始终是 90 的倍数） */
  rotation: number
  /** true = 按原始像素显示（1:1）；false = 适应窗口 */
  actualSize: boolean

  open: (images: string[], index: number) => void
  close: () => void
  next: () => void
  prev: () => void
  zoom: (delta: number) => void
  /** 回到「适应窗口 + 居中」（双击 / 0 键）—— 旋转保留，转半天一复位就歪回去很恼人 */
  reset: () => void
  setView: (patch: Partial<{ scale: number; tx: number; ty: number }>) => void
  rotate: (delta: number) => void
  setActualSize: (on: boolean) => void
}

export const useImageLightbox = create<ImageLightboxState>((set) => ({
  images: [],
  index: 0,
  ...FRESH,

  open: (images, index) => set({ images, index, ...FRESH }),
  close: () => set({ images: [], index: 0, ...FRESH }),

  next: () =>
    set((s) => (s.images.length === 0 ? s : { index: (s.index + 1) % s.images.length, ...FRESH })),
  prev: () =>
    set((s) =>
      s.images.length === 0
        ? s
        : { index: (s.index - 1 + s.images.length) % s.images.length, ...FRESH },
    ),

  zoom: (delta) => set((s) => ({ scale: clampScale(s.scale + delta) })),
  reset: () => set({ scale: 1, tx: 0, ty: 0, actualSize: false }),

  setView: (patch) =>
    set(patch.scale === undefined ? patch : { ...patch, scale: clampScale(patch.scale) }),

  /* 转完重新居中：原来的平移量是按没转的方向算的，留着图会跑到屏幕外 */
  rotate: (delta) => set((s) => ({ rotation: (s.rotation + delta + 360) % 360, tx: 0, ty: 0 })),

  setActualSize: (on) => set({ actualSize: on, scale: 1, tx: 0, ty: 0 }),
}))

/** 从 DOM 收集当前对话里所有图片并打开 —— 见 Inline.tsx / ToolRuns.tsx 的调用处 */
export function openImageFromDom(src: string): void {
  const all = [...document.querySelectorAll('[data-chat-image]')]
    .map((el) => el.getAttribute('src'))
    .filter((value): value is string => Boolean(value))
  /* 去重，保持先后顺序 */
  const images = [...new Set(all)]
  const index = Math.max(0, images.indexOf(src))
  useImageLightbox.getState().open(images, index)
}
