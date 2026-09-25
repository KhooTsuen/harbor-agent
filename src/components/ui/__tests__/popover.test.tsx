import { act, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Popover } from '../Popover'

/* ══════════════════════════════════════════════════════════════
   浮层定位（验收 a–f 的单测面）

   jsdom 没有真实布局：所有矩形都靠全局 mock 的 getBoundingClientRect 给，
   用「改矩形 → 派发 scroll / resize → 断言面板 left/top」驱动 floating-ui
   的重算链路。真机行为另见 tmp/float-run.cjs 的探针。

   真机 bug 现场（这条链路要防的）：
     · 面板被夹死在视口顶，滚动位移=0（不跟随锚点）
     · 锚点滚出滚动容器后，面板还挂着挡消息
   ══════════════════════════════════════════════════════════════ */

const R = (width: number, height: number, left = 0, top = 0): DOMRect =>
  ({
    width,
    height,
    left,
    top,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
  }) as DOMRect

/**
 * 元素 → 矩形。测试里手动塞；没塞的元素（祖先链 / 还没量的面板）给「视口同款」兜底矩形：
 * 既让 hide 中间件看到正常的裁剪边界（不至于误报「锚点不可见」），
 * 也让 flip / shift 的边界计算和真实浏览器一致。
 */
const rects = new WeakMap<Element, DOMRect>()
const FALLBACK = R(1024, 768, 0, 0)

let container: HTMLDivElement
let root: Root
let openCalls: boolean[]

function App(): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        openCalls.push(next)
        setOpen(next)
      }}
      trigger={({ toggle }) => <button onClick={toggle}>开菜单</button>}
    >
      <button type="button" role="menuitem">
        选项一
      </button>
    </Popover>
  )
}

const anchor = (): HTMLElement => container.querySelector('.inline-flex') as HTMLElement
const panel = (): HTMLElement | null => document.body.querySelector('[role="menu"]')
/** 等面板拿到定位（isPositioned 后才会写 left/top 生效坐标） */
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** 点触发器把菜单打开，等首帧定位完成 */
async function openMenu(): Promise<void> {
  act(() => {
    ;(container.querySelector('button') as HTMLButtonElement).click()
  })
  await flush()
}

/** 改矩形 → 派发事件 → 等重算 */
async function nudge(event: string, target: EventTarget = window): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new Event(event))
    await Promise.resolve()
  })
  await flush()
  await vi.waitFor(() => {
    expect(panel()?.style.visibility).toBe('visible')
  })
  await flush()
}

beforeEach(() => {
  openCalls = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  /*
   * jsdom 没有布局引擎：documentElement.clientWidth / clientHeight 都是 0。
   * floating-ui 用它推「视口」—— 不补上的话视口被算成 0×0，什么锚点都算被裁掉
   * （hide 会秒关、shift 会把面板全夹到 padding）。补成 jsdom 默认窗口尺寸。
   */
  Object.defineProperty(document.documentElement, 'clientWidth', {
    value: 1024,
    configurable: true,
  })
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: 768,
    configurable: true,
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return rects.get(this) ?? FALLBACK
  })
  /*
   * ★ floating-ui 量**浮层**的宽高走的是 offsetWidth / offsetHeight（不是
   * getBoundingClientRect）—— jsdom 里恒为 0，不补上的话位置算式里面板永远 0×0。
   */
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return rects.get(this)?.width ?? 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return rects.get(this)?.height ?? 0
    },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.querySelectorAll('[role="menu"]').forEach((el) => el.remove())
  vi.restoreAllMocks()
})

describe('打开与关闭（验收 f）', () => {
  it('f · 打开后浮层挂在 body 上（portal），初始位置贴着锚点', async () => {
    act(() => root.render(<App />))
    rects.set(anchor(), R(100, 30, 200, 400))
    await openMenu()
    expect(panel()).toBeTruthy()
    expect(container.contains(panel())).toBe(false)

    rects.set(panel()!, R(320, 240))
    await nudge('scroll')

    /* 向上弹：top = 锚点.top - 面板高 - 间隙(6) */
    expect(panel()!.style.top).toBe('154px')
    expect(panel()!.style.left).toBe('200px')
  })

  it('f · Esc 关掉', async () => {
    act(() => root.render(<App />))
    await openMenu()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(openCalls).toContain(false)
    /* 退场动画跑完才真正卸载 —— 等它 */
    await vi.waitFor(() => {
      expect(panel()).toBeFalsy()
    })
  })

  it('f · 点外面关掉；点面板里不关', async () => {
    act(() => root.render(<App />))
    await openMenu()
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(openCalls).toContain(false)
    await vi.waitFor(() => {
      expect(panel()).toBeFalsy()
    })

    /* 再来一轮：点面板里 → 不关 */
    openCalls = []
    await openMenu()
    act(() => {
      panel()!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(openCalls).not.toContain(false)
  })
})

describe('跟随与重算（验收 a / c）', () => {
  it('a · 滚动导致锚点位移 → 面板跟着走（不再停在原地）', async () => {
    act(() => root.render(<App />))
    rects.set(anchor(), R(100, 30, 200, 400))
    await openMenu()
    rects.set(panel()!, R(320, 240))
    await nudge('scroll')
    expect(panel()!.style.top).toBe('154px')

    /* 滚动 120px：锚点上移 120 → 面板也要上移 120 */
    rects.set(anchor(), R(100, 30, 200, 280))
    await nudge('scroll')
    expect(panel()!.style.top).toBe('34px')
  })

  it('c · 窗口缩放（resize）后位置也重算', async () => {
    act(() => root.render(<App />))
    rects.set(anchor(), R(100, 30, 200, 400))
    await openMenu()
    rects.set(panel()!, R(320, 240))
    await nudge('resize')
    expect(panel()!.style.left).toBe('200px')

    rects.set(anchor(), R(100, 30, 300, 400))
    await nudge('resize')
    expect(panel()!.style.left).toBe('300px')
  })
})

describe('不越界（验收 d）', () => {
  it('d · 上方放不下 → 翻到下面（不再被夹死）', async () => {
    /* 锚点贴在视口顶部：向上弹会溢出 → flip 到底部 */
    act(() => root.render(<App />))
    rects.set(anchor(), R(100, 30, 200, 4))
    await openMenu()
    rects.set(panel()!, R(320, 240))
    await nudge('scroll')
    expect(panel()!.style.top).toBe('40px') // 4 + 30 + 6
  })

  it('d · 右侧放不下 → 横向夹回（crossAxis）', async () => {
    /* 视口 1024 宽：锚点在 900，面板 320 宽 → 不夹的话右缘会越界 */
    act(() => root.render(<App />))
    rects.set(anchor(), R(100, 30, 900, 400))
    await openMenu()
    rects.set(panel()!, R(320, 240))
    await nudge('scroll')
    const left = parseFloat(panel()!.style.left)
    /* 行为口径：确实被夹了（< 900），且右缘不越出视口（留 8px 边距）——
       具体像素由 floating-ui 的 padding 算术决定，不写死 */
    expect(left).toBeLessThan(900)
    expect(left + 320).toBeLessThanOrEqual(1024 - 8 + 1)
  })
})

describe('锚点滚出可视区（验收 b）', () => {
  it('b · 锚点被完全裁掉（滚出滚动容器）→ 浮层自动关闭', async () => {
    act(() => root.render(<App />))
    rects.set(anchor(), R(100, 30, 200, 400))
    await openMenu()
    rects.set(panel()!, R(320, 240))
    await nudge('scroll')
    expect(panel()).toBeTruthy()

    /* 锚点滚到视口上方（完全不可见）→ hide 中间件报 referenceHidden → 关闭 */
    rects.set(anchor(), R(100, 30, 200, -500))
    await act(async () => {
      window.dispatchEvent(new Event('scroll'))
      await Promise.resolve()
    })
    await flush()
    await vi.waitFor(() => {
      expect(openCalls).toContain(false)
    })
    await vi.waitFor(() => {
      expect(panel()).toBeFalsy()
    })
  })
})
