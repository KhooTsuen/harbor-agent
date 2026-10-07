import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDomStubs } from './domStubs'
import { ImageLightbox } from '../ImageLightbox'
import { MAX_SCALE, MIN_SCALE, useImageLightbox } from '@/stores/useImageLightbox'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   图片全屏查看器

   真渲染、真点按钮（这个项目反复踩过「源码断言到注释里的字」的坑）。
   要钉住的是四件事：

    ① 视图状态：缩放夹取范围 / 旋转归一化 / 换图与关闭复位 / 复位保留旋转
    ② 外壳：没图不渲染、多图才有左右箭头、Esc 与点背景关闭、点图不关闭
    ③ 拖动与滚轮：拖了会位移、滚轮以鼠标位置为中心放大
    ④ 跟系统打交道：另存为 / 显示 / 复制真的调桥，浏览器预览里不炸

   jsdom 的坑：没有指针捕获、指针事件的 clientX 得用 MouseEvent 派发。
   ══════════════════════════════════════════════════════════════ */

installDomStubs()

if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  Object.assign(Element.prototype, {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => false,
  })
}

let container: HTMLDivElement
let root: Root

const A = 'file:///E:/demo/a.jpg'
const B = 'file:///E:/demo/b.jpg'

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useImageLightbox.setState(useImageLightbox.getInitialState())
  useUIStore.setState({ toasts: [] })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as { workbench?: unknown }).workbench
})

function mount(images: string[] = [A]): void {
  useImageLightbox.getState().open(images, 0)
  act(() => root.render(<ImageLightbox />))
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label,
  ) as HTMLButtonElement | undefined
}

/** 派发一个指针事件 —— jsdom 没有 PointerEvent，用 MouseEvent 顶（clientX 够用） */
function pointer(
  el: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }))
}

const stage = (): HTMLElement => container.querySelector('[role="dialog"] > div') as HTMLElement
const dialog = (): HTMLElement | null => container.querySelector('[role="dialog"]')

describe('查看器 / 视图状态', () => {
  it('刚打开是适应窗口：不放大、不位移、不旋转', () => {
    mount()
    const s = useImageLightbox.getState()
    expect([s.scale, s.tx, s.ty, s.rotation, s.actualSize]).toEqual([1, 0, 0, 0, false])
  })

  it('★ 缩放夹在范围内（连按放大到不了无穷大，缩到底也有下限）', () => {
    mount()
    act(() => {
      for (let i = 0; i < 60; i += 1) useImageLightbox.getState().zoom(0.25)
    })
    expect(useImageLightbox.getState().scale).toBe(MAX_SCALE)
    act(() => {
      for (let i = 0; i < 80; i += 1) useImageLightbox.getState().zoom(-0.25)
    })
    expect(useImageLightbox.getState().scale).toBe(MIN_SCALE)
  })

  it('★ 换图 / 关闭都复位视角（不然下一张还停在上一次的放大倍数）', () => {
    mount([A, B])
    act(() => {
      useImageLightbox.getState().zoom(1)
      useImageLightbox.getState().setView({ tx: 120, ty: -40 })
      useImageLightbox.getState().next()
    })
    const s = useImageLightbox.getState()
    expect([s.index, s.scale, s.tx, s.ty, s.rotation]).toEqual([1, 1, 0, 0, 0])
  })

  it('★ 旋转归一化到 0–359，而且转完重新居中（否则图会跑到屏幕外）', () => {
    mount()
    act(() => {
      useImageLightbox.getState().setView({ tx: 60, ty: 60 })
      useImageLightbox.getState().rotate(-90)
    })
    expect(useImageLightbox.getState().rotation).toBe(270)
    expect([useImageLightbox.getState().tx, useImageLightbox.getState().ty]).toEqual([0, 0])

    act(() => {
      useImageLightbox.getState().rotate(90)
    })
    expect(useImageLightbox.getState().rotation).toBe(0)
  })

  it('★ 双击复位保留旋转角度（转半天一复位就歪回去很恼人）', () => {
    mount()
    act(() => {
      useImageLightbox.getState().rotate(90)
      useImageLightbox.getState().zoom(2)
      useImageLightbox.getState().reset()
    })
    const s = useImageLightbox.getState()
    expect([s.scale, s.rotation, s.tx, s.ty]).toEqual([1, 90, 0, 0])
  })

  it('切到「原始大小」会把倍率归 1（1:1 就是原始像素，不是再叠一层缩放）', () => {
    mount()
    act(() => {
      useImageLightbox.getState().zoom(2)
      useImageLightbox.getState().setActualSize(true)
    })
    expect(useImageLightbox.getState().actualSize).toBe(true)
    expect(useImageLightbox.getState().scale).toBe(1)
  })
})

describe('查看器 / 外壳', () => {
  it('没有图时不渲染', () => {
    act(() => root.render(<ImageLightbox />))
    expect(dialog()).toBeNull()
  })

  it('★ 工具条上六个动作都在（适应 / 1:1 / 旋转 / 另存为 / 显示 / 复制）', () => {
    mount()
    for (const label of [
      '适应窗口',
      '原始大小',
      '旋转 90°',
      '另存为',
      '在文件夹里显示',
      '复制图片',
    ]) {
      expect(button(label), label).toBeTruthy()
    }
    expect(container.textContent).toContain('100%')
  })

  it('只有一张图时没有左右箭头，也不显示张数', () => {
    mount([A])
    expect(button('上一张')).toBeUndefined()
    expect(container.textContent).not.toContain('1 / 1')
  })

  it('多张图时出现左右箭头和张数', async () => {
    mount([A, B])
    expect(container.textContent).toContain('1 / 2')
    await act(async () => button('下一张')?.click())
    expect(container.textContent).toContain('2 / 2')
  })

  it('★ Esc 关闭', () => {
    mount()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(useImageLightbox.getState().images).toEqual([])
  })

  it('★ 点背景关闭、点图片不关闭', () => {
    mount()
    act(() => {
      container
        .querySelector('[role="dialog"] img')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useImageLightbox.getState().images).toEqual([A])

    act(() => {
      dialog()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useImageLightbox.getState().images).toEqual([])
  })
})

describe('查看器 / 拖动与滚轮', () => {
  it('★ 按住拖 → 图片跟着位移', () => {
    mount()
    act(() => {
      pointer(stage(), 'pointerdown', 100, 100)
      pointer(stage(), 'pointermove', 160, 130)
    })
    const s = useImageLightbox.getState()
    expect([s.tx, s.ty]).toEqual([60, 30])
  })

  it('★ 滚轮以鼠标位置为中心放大（光标底下那个点不该跑走）', () => {
    mount()
    act(() => {
      stage().dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -100, clientX: 200, clientY: 0 }),
      )
    })
    const s = useImageLightbox.getState()
    expect(s.scale).toBeGreaterThan(1)
    expect(s.tx).toBeLessThan(0)
  })
})

describe('查看器 / 跟系统打交道', () => {
  it('★ 「另存为」把当前这张图交给主进程，成功给提示', async () => {
    const imageSaveAs = vi.fn(async () => ({ ok: true, path: 'E:/demo/saved.jpg' }))
    window.workbench = { imageSaveAs } as unknown as Window['workbench']
    mount()
    await act(async () => button('另存为')?.click())
    expect(imageSaveAs).toHaveBeenCalledWith(A)
    expect(useUIStore.getState().toasts.some((t) => t.title === '图片已保存')).toBe(true)
  })

  it('★ 主进程说没做成 → 报错提示（不假装成功）', async () => {
    const imageCopy = vi.fn(async () => ({ ok: false, error: '照片格式不支持' }))
    window.workbench = { imageCopy } as unknown as Window['workbench']
    mount()
    await act(async () => button('复制图片')?.click())
    const toast = useUIStore.getState().toasts.at(-1)
    expect(toast?.title).toBe('没做成')
    expect(toast?.description).toBe('照片格式不支持')
  })

  it('★ 浏览器预览里（没有桥）点了也不炸，只提示', async () => {
    mount()
    await act(async () => button('在文件夹里显示')?.click())
    expect(useUIStore.getState().toasts.at(-1)?.title).toBe('这个功能要在桌面版里用')
  })
})
