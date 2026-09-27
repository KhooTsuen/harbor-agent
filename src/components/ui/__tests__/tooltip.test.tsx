import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IconButton } from '../IconButton'
import { Tooltip } from '../Tooltip'

/* ══════════════════════════════════════════════════════════════
   提示（tooltip）的两条真机 bug 回归（用户 2026-09-28 截图）

   ① 「两个提示叠一起」—— IconButton 自带原生 `title`，外面又包一层样式化
      提示：悬停时两个框一起弹（侧栏「单独对话」那个 + 最明显）。
      现在提示只有一套：IconButton 自己渲染，外面那层只把文案递进去。
      单测能抓的：按钮**不能**再有原生 title 属性，且 `[role="tooltip"]` 只有一个。
      （原生提示不在 DOM 里，所以只能靠 title 属性这一条来钉。）

   ② 「提示被裁掉半截」—— 提示原来是绝对定位在触发器旁边的 span，落在
      侧栏滚动容器（overflow-y-auto）里就被裁。
      现在 portal 到 body：断言「提示不在滚动容器里、父节点是 body」。

   jsdom 没有布局：矩形/尺寸都靠全局 mock（抄 popover.test.tsx 那套，
   floating-ui 量浮层走的是 offsetWidth / offsetHeight，不是 getBoundingClientRect）。
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

const rects = new WeakMap<Element, DOMRect>()
const FALLBACK = R(1024, 768, 0, 0)

let container: HTMLDivElement
let root: Root

const tips = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="tooltip"]'))

/**
 * 悬停：派发 **mouseover**（React 的 `onMouseEnter` 是从 mouseover 合成的）。
 * 懒挂载下「有没有被碰过」靠 React 事件判断，所以这里不能用原生 mouseenter。
 */
async function hover(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function unhover(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mouseleave'))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

/** 侧栏那种「滚动容器」：提示要是落在里面，就会被裁 */
function InScroller({ children }: { children: ReactElement }): ReactElement {
  return (
    <div data-testid="scroller" style={{ overflowY: 'auto', height: 200 }}>
      {children}
    </div>
  )
}

const render = (ui: ReactElement): void => {
  act(() => root.render(ui))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
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
  tips().forEach((el) => el.remove())
  vi.restoreAllMocks()
})

describe('① 一个按钮只有一个提示（不再和原生 title 打架）', () => {
  it('Tooltip 包 IconButton：无原生 title，悬停只出一个提示，文案用 Tooltip 的', async () => {
    render(
      <Tooltip content="新建单独对话（不挂目录，用默认工作目录）">
        <IconButton label="新建单独对话">+</IconButton>
      </Tooltip>,
    )
    const btn = container.querySelector('button') as HTMLButtonElement

    /* ★ 原生 title 必须没有 —— 有它就会多弹一个灰框 */
    expect(btn.getAttribute('title')).toBeNull()
    expect(btn.getAttribute('aria-label')).toBe('新建单独对话')
    /* ★ 碰它之前不许有任何浮层机器/关联（列表里几百个按钮都各挂一套的话，切会话会变慢） */
    expect(tips()).toHaveLength(0)
    expect(btn.getAttribute('aria-describedby')).toBeNull()

    await hover(btn)
    expect(tips()).toHaveLength(1)
    expect(tips()[0].textContent).toBe('新建单独对话（不挂目录，用默认工作目录）')
    /* 无障碍关联指到那唯一的提示上 */
    expect(btn.getAttribute('aria-describedby')).toBe(tips()[0].id)
  })

  it('单独用的 IconButton 也有提示（以前靠原生 title，现在自己渲染）', async () => {
    render(<IconButton label="发送">→</IconButton>)
    const btn = container.querySelector('button') as HTMLButtonElement
    expect(btn.getAttribute('title')).toBeNull()
    await hover(btn)
    expect(tips()).toHaveLength(1)
    expect(tips()[0].textContent).toBe('发送')
  })

  it('hint 比 label 长时用 hint，label 仍是无障碍名字', async () => {
    render(
      <IconButton label="新建对话" hint="新建对话（Ctrl+N）">
        +
      </IconButton>,
    )
    const btn = container.querySelector('button') as HTMLButtonElement
    await hover(btn)
    expect(tips()[0].textContent).toBe('新建对话（Ctrl+N）')
    expect(btn.getAttribute('aria-label')).toBe('新建对话')
  })

  it('hint="" 就是「不要提示」（顶栏那四个故意不弹提示的按钮）', async () => {
    render(
      <IconButton label="切换底部面板" hint="">
        ▭
      </IconButton>,
    )
    const btn = container.querySelector('button') as HTMLButtonElement
    await hover(btn)
    expect(tips()).toHaveLength(0)
    /* 无障碍名字还在 */
    expect(btn.getAttribute('aria-label')).toBe('切换底部面板')
  })

  it('按钮自己的事件照常：onClick 不被提示的 props 吃掉', async () => {
    const onClick = vi.fn()
    render(
      <Tooltip content="点我">
        <IconButton label="点我" onClick={onClick}>
          ✓
        </IconButton>
      </Tooltip>,
    )
    const btn = container.querySelector('button') as HTMLButtonElement
    act(() => {
      btn.click()
    })
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('② 提示不被滚动容器裁掉', () => {
  it('提示挂在 body 上（不在 overflow 容器里），滚动容器裁不到', async () => {
    render(
      <InScroller>
        <Tooltip content="在这个文件夹里新建对话">
          <IconButton label="新建对话">+</IconButton>
        </Tooltip>
      </InScroller>,
    )
    const btn = container.querySelector('button') as HTMLButtonElement
    await hover(btn)
    expect(tips()).toHaveLength(1)
    expect(tips()[0].parentElement).toBe(document.body)
    expect(container.contains(tips()[0])).toBe(false)
    /* 定位算完了才该显示（浮层量不到的话永远是 hidden —— 真机上就是「悬停没提示」） */
    expect(tips()[0].style.visibility).toBe('visible')
    expect(tips()[0].style.position).toBe('fixed')
    expect(tips()[0].style.left).not.toBe('')
  })

  it('非 IconButton 的子元素（通用分支）也能出提示，同样挂 body 上', async () => {
    render(
      <Tooltip content="说明文字">
        <span>普通元素</span>
      </Tooltip>,
    )
    const anchor = container.querySelector('.inline-flex') as HTMLElement
    await hover(anchor)
    expect(tips()).toHaveLength(1)
    expect(tips()[0].textContent).toBe('说明文字')
    expect(tips()[0].parentElement).toBe(document.body)
  })
})

describe('③ 关掉的两个出口', () => {
  it('鼠标移开就收；再移回去又出', async () => {
    render(<IconButton label="重新启动终端">↻</IconButton>)
    const btn = container.querySelector('button') as HTMLButtonElement
    await hover(btn)
    expect(tips()).toHaveLength(1)
    await unhover(btn)
    expect(tips()).toHaveLength(0)
    await hover(btn)
    expect(tips()).toHaveLength(1)
  })

  it('窗口失焦会收（提示挂在 body 上，收不到 mouseleave，这条不能丢）', async () => {
    render(<IconButton label="清屏">⌫</IconButton>)
    const btn = container.querySelector('button') as HTMLButtonElement
    await hover(btn)
    expect(tips()).toHaveLength(1)
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(tips()).toHaveLength(0)
  })
})
