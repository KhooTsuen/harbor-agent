import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MessageList } from '../MessageList'
import { useScrollStore } from '@/stores/useScrollStore'
import type { Message } from '@/types'

/* ══════════════════════════════════════════════════════════════
   滚动测试的取景器

   jsdom 没有布局：`scrollHeight / clientHeight / scrollTop` 恒为 0，测不出
   任何位移。所以这里把三个维度**接管**成一台假尺子（`dims`），并给
   scrollTop 的 setter 记账（`writes`）—— 「程序到底写没写视图」这件事必须
   能数出来，它是本套测试的核心证据。

   另外两个替身：
     · ResizeObserver —— 回调抓在手里，由 `grow()` 手动触发
     · requestAnimationFrame —— 排队，`flushRaf()` 手动跑
   ══════════════════════════════════════════════════════════════ */

type ROCallback = () => void

export const dims = { contentHeight: 2000, clientHeight: 500, scrollTop: 0 }
/** 程序一共写了几次 scrollTop（用户动作不走这里） */
export const writes = { count: 0 }
/** 假文档坐标：某个元素在滚动内容里的位置 + 它多高（没登记的元素高度算 0） */
export const rects = new Map<Element, { offset: number; height: number }>()

let roCallback: ROCallback | null = null
let rafQueue: Array<() => void> = []
let container: HTMLDivElement
let root: Root

const original = {
  scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight'),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
  scrollTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop'),
  rect: Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect'),
  raf: globalThis.requestAnimationFrame,
  cancel: globalThis.cancelAnimationFrame,
}

export function setup(): void {
  roCallback = null
  rafQueue = []
  writes.count = 0
  rects.clear()
  dims.contentHeight = 2000
  dims.clientHeight = 500
  dims.scrollTop = 0
  /* 每条对话的滚动记忆是全局 store —— 测试之间必须清干净 */
  useScrollStore.setState({ byThread: {} })

  globalThis.ResizeObserver = class {
    constructor(cb: ROCallback) {
      roCallback = cb
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver

  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    rafQueue.push(() => cb(0))
    return rafQueue.length
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame

  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => dims.contentHeight,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => dims.clientHeight,
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get: () => dims.scrollTop,
    set: (value: number) => {
      writes.count += 1
      dims.scrollTop = value
    },
  })
  /*
   * 假「视图坐标」：元素 top = 文档位置 − scrollTop。
   * 滚动容器自己不算（它的 top 是相对窗口固定的 0），靠 tabindex=-1 认出来 ——
   * 判据与 `scroller()` 一致。没登记的元素高度算 0（只靠总高度的那种老用例不受影响）。
   */
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element): DOMRect {
      const r = rects.get(this)
      const isScroller = this.matches('div[tabindex="-1"]')
      const top = isScroller ? 0 : (r?.offset ?? 0) - dims.scrollTop
      const height = isScroller ? dims.clientHeight : (r?.height ?? 0)
      return {
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect
    },
  })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
}

export function teardown(): void {
  act(() => root.unmount())
  container.remove()
  for (const [key, desc] of [
    ['scrollHeight', original.scrollHeight],
    ['clientHeight', original.clientHeight],
    ['scrollTop', original.scrollTop],
  ] as const) {
    if (desc) Object.defineProperty(HTMLElement.prototype, key, desc)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
  }
  if (original.rect)
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', original.rect)
  globalThis.requestAnimationFrame = original.raf
  globalThis.cancelAnimationFrame = original.cancel
}

/** 渲染消息列表（可以反复调用来模拟重渲 / 换对话） */
export function render(messages: readonly Message[], conversationId = 't1'): void {
  act(() => {
    root.render(<MessageList messages={messages} conversationId={conversationId} />)
  })
}

/**
 * 消息列表的滚动容器。
 *
 * ★ 别用 `div.overflow-y-auto` 找：**开屏（LaunchScreen）也是 overflow-y-auto**，
 * 切过来切过去时那个选择器会指错人。消息列表的容器是唯一带 tabIndex=-1 的。
 */
export function scroller(): HTMLDivElement {
  const el = container.querySelector('div[tabindex="-1"]')
  if (!el) throw new Error('找不到滚动容器（消息列表还没挂上？）')
  return el as HTMLDivElement
}

/** 离底还有多少像素（整台假尺子唯一的口径） */
export function bottomDistance(): number {
  return dims.contentHeight - dims.scrollTop - dims.clientHeight
}

/** 内容长高（流式追加 / 展开块）→ 触发 ResizeObserver 回调 */
export function grow(delta: number): void {
  dims.contentHeight += delta
  act(() => roCallback?.())
}

/** 用户滚到某个位置（拖滚动条 / 触摸 / 键盘滚动走的是同一条路） */
export function userScrollTo(top: number): void {
  dims.scrollTop = top
  act(() => {
    scroller().dispatchEvent(new Event('scroll'))
  })
}

export function wheel(deltaY: number): void {
  act(() => {
    scroller().dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true }))
  })
}

export function pressKey(key: string): void {
  act(() => {
    scroller().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

export function buttonByText(text: string): HTMLButtonElement | null {
  return (
    ([...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text)) as
      HTMLButtonElement | undefined) ?? null
  )
}

export function clickButton(text: string): void {
  const btn = buttonByText(text)
  if (!btn) throw new Error(`找不到按钮：${text}`)
  act(() => btn.click())
}

/** 「回到底部」在不在（FREE 的唯一界面投影） */
export function jumpVisible(): boolean {
  return (container.textContent ?? '').includes('回到底部')
}

export function text(): string {
  return container.textContent ?? ''
}

/** 跑掉排队里的 rAF（程序滚动标记的过期用的是它） */
export function flushRaf(rounds = 2): void {
  for (let i = 0; i < rounds && rafQueue.length > 0; i += 1) {
    const batch = rafQueue
    rafQueue = []
    act(() => {
      for (const cb of batch) cb()
    })
  }
}

/* ── 假布局：给消息区的子节点铺一套「文档坐标」 ──────────────── */

/** 消息区的内容容器（判据 .max-w-3xl，与真机探针一致） */
export function contentEl(): HTMLElement {
  const el = container.querySelector('.max-w-3xl')
  if (!el) throw new Error('找不到内容容器（.max-w-3xl）')
  return el as HTMLElement
}

export function contentChildren(): HTMLElement[] {
  return [...contentEl().children] as HTMLElement[]
}

/** 元素当前的「视图坐标」（等价于真实 getBoundingClientRect().top） */
export function viewportTopOf(el: Element): number {
  return el.getBoundingClientRect().top
}

/** 按顺序给内容容器的子节点铺高度（文档坐标从 0 起），并同步总高度 */
export function layout(heights: number[]): void {
  let offset = 0
  const kids = contentChildren()
  for (let i = 0; i < kids.length; i += 1) {
    const h = heights[i] ?? heights[heights.length - 1] ?? 0
    rects.set(kids[i], { offset, height: h })
    offset += h
  }
  dims.contentHeight = offset
  /* 铺布局本身也是「内容尺寸变了」—— 通知观察者，让 FOLLOW 重新贴上新的底 */
  act(() => roCallback?.())
}

/**
 * 视野**上方**长高 / 收回：从第 index 个子节点起整体下移 delta。
 * 等价于「在视野上方展开一个块」「上面图片加载完」「载入更早的消息」。
 */
export function growAbove(index: number, delta: number): void {
  const kids = contentChildren()
  for (let i = index; i < kids.length; i += 1) {
    const r = rects.get(kids[i])
    if (r) r.offset += delta
  }
  dims.contentHeight += delta
  act(() => roCallback?.())
}

/** 末尾长高（流式追加的样子）：只长总高度，所有子节点的文档位置一动不动 */
export function growTail(delta: number): void {
  dims.contentHeight += delta
  act(() => roCallback?.())
}

/* ── 消息取景 ─────────────────────────────────────────────── */

export function fixture(overrides: Partial<Message>): Message {
  return {
    id: 'm',
    threadId: 't1',
    role: 'assistant',
    content: '正文',
    kind: 'text',
    status: 'sent',
    timestamp: 1,
    ...overrides,
  }
}

/** 历史那条：有思考块、已经写完 */
export const historyMsg = fixture({
  id: 'h1',
  content: '历史回答',
  reasoning: '历史思考：先看现状再说',
})

/** 正在流式的那条：也有思考块（「最新思考块」就是它） */
export const streamingMsg = fixture({
  id: 's1',
  content: '正在生成……',
  reasoning: '先想想：复制一份到临时目录',
  status: 'streaming',
  timestamp: 2,
})
