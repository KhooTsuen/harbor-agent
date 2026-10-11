import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Markdown } from '../Markdown'
import { installDomStubs } from './domStubs'

installDomStubs()

/* ══════════════════════════════════════════════════════════════
   扩展渲染：HTML 直通 / 公式 / Mermaid

   解析层由 `src/lib/markdown/__tests__/extensions.test.ts` 钉住，
   这里钉**渲染层**：节点真的进了 DOM（不是只在数据层对）。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterAll(() => {
  act(() => root.unmount())
  container.remove()
  globalThis.localStorage?.removeItem('harbor.rawHtml')
})

function draw(text: string): void {
  act(() => {
    root.render(<Markdown text={text} />)
  })
}

describe('HTML 直通（渲染层）', () => {
  it('★ 默认关：没设置过开关时不直通（安全清单 SEC-002）', () => {
    globalThis.localStorage?.removeItem('harbor.rawHtml')
    draw('前 <b>粗</b> 后')
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('<b>粗</b>')
  })

  it('显式打开后才直通：<b> 变成真的粗体元素', () => {
    globalThis.localStorage?.setItem('harbor.rawHtml', '1')
    /* 文本要与上面的用例不同 —— Markdown 是 memo 的，相同 props 不会重渲 */
    draw('打开 <b>粗体</b> 看效果')
    expect(container.querySelector('b')?.textContent).toBe('粗体')
    globalThis.localStorage?.removeItem('harbor.rawHtml')
  })

  it('★ 打开时属性原样落地（onerror 会被保留 —— 这就是打开口子的代价）', () => {
    globalThis.localStorage?.setItem('harbor.rawHtml', '1')
    draw('<img src="x" onerror="window.__pwn=1">')
    expect(container.querySelector('img')?.getAttribute('onerror')).toBe('window.__pwn=1')
    globalThis.localStorage?.removeItem('harbor.rawHtml')
  })

  it('★ 开关关掉后退化成纯文本', () => {
    globalThis.localStorage?.setItem('harbor.rawHtml', '0')
    draw('再来 <b>一次</b>')
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('<b>一次</b>')
    globalThis.localStorage?.removeItem('harbor.rawHtml')
  })
})

describe('公式（渲染层）', () => {
  it('行内 $…$ 渲染出 KaTeX DOM', () => {
    draw('质能方程 $E=mc^2$ 很好记')
    expect(container.querySelector('.katex')).not.toBeNull()
  })

  it('块级 $$…$$ 渲染成 display 模式', () => {
    draw('$$a^2+b^2=c^2$$')
    expect(container.querySelector('.katex-display')).not.toBeNull()
  })

  it('★ 写坏的公式不炸整条消息（退化成原文）', () => {
    draw('看这个 $\\frac{1}{$ 是坏的')
    expect(container.textContent).toContain('frac')
  })
})

describe('Mermaid（渲染层）', () => {
  it('```mermaid 走图表分支（成功出 SVG，失败退化成代码）', async () => {
    draw('```mermaid\ngraph TD\n  A-->B\n```')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    const hasSvg = container.querySelector('svg') !== null
    const fellBack = container.querySelector('pre') !== null
    expect(hasSvg || fellBack).toBe(true)
  })
})
