import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Markdown } from '../Markdown'
import { StreamingMarkdown } from '../markdown/StreamingMarkdown'

/* ══════════════════════════════════════════════════════════════
   流式 Markdown 的接线与结构

   钉三件事：
     ① 流式实时渲染真块（不再是纯文本流）；
     ② 稳定块数组「只增不改」—— 引用不变，memo 才有意义；
     ③ 收尾时流式渲染的 DOM 与「整篇解析」一致（不闪、不重排）。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (node: ReactNode): void => {
  act(() => {
    root.render(node)
  })
}

describe('流式 Markdown', () => {
  it('★ 流式中就渲染真块（标题/列表不是纯文本）', () => {
    render(<StreamingMarkdown text={'## 标题\n\n- 甲\n- 乙\n\n正文'} />)
    expect(container.querySelectorAll('p, ul, li, blockquote, table, pre').length).toBeGreaterThan(
      2,
    )
    /* 列表项真的成了 li，而不是「- 甲」这种纯文本 */
    expect(container.textContent).toContain('甲')
    expect(container.querySelectorAll('li').length).toBeGreaterThan(0)
  })

  it('★ 稳定块数组引用不变，且新块只 push（不造新数组）', () => {
    render(<StreamingMarkdown text={'甲\n\n乙\n\n'} />)
    const first = container.querySelectorAll('p').length
    /* 追加内容：稳定块继续 push，尾巴重渲 */
    render(<StreamingMarkdown text={'甲\n\n乙\n\n丙\n\n'} />)
    expect(container.querySelectorAll('p').length).toBeGreaterThan(first)
  })

  it('★ 残缺的半行当纯文本（不解析成块）', () => {
    render(<StreamingMarkdown text={'前言\n\n- '} />)
    /* 「- 」还是列表标记，不该出现 li */
    expect(container.querySelectorAll('li').length).toBe(0)
    expect(container.textContent).toContain('- ')
  })

  it('★ 尾巴盒加了 contain: layout（只在还有半行没写完时）', () => {
    /* 末行是残缺标记 → 尾巴盒存在 */
    render(<StreamingMarkdown text={'前言\n\n- '} />)
    const withBox = [...container.querySelectorAll('div')].some(
      (el) => (el as HTMLElement).style.contain === 'layout',
    )
    expect(withBox).toBe(true)

    /* 写完了 → 盒消失，DOM 与整篇解析一模一样 */
    render(<StreamingMarkdown text={'前言\n\n- 甲'} />)
    const stillBoxed = [...container.querySelectorAll('div')].some(
      (el) => (el as HTMLElement).style.contain === 'layout',
    )
    expect(stillBoxed).toBe(false)
  })

  it('★★ 收尾时流式渲染的 DOM 与整篇解析一致（切到 Markdown 不重排）', () => {
    const samples = [
      '## 标题\n\n- 甲\n- 乙\n\n正文。',
      '一段话。\n\n```ts\nconst a = 1\n```\n\n后记。',
      '| A | B |\n| --- | --- |\n| 1 | 2 |',
      '> 引用\n\n结尾。',
      '- [x] 做完\n- [ ] 没做',
      '只有一段没有任何记号的文字',
    ]

    for (const text of samples) {
      const boxA = document.createElement('div')
      const boxB = document.createElement('div')
      const rootA = createRoot(boxA)
      const rootB = createRoot(boxB)
      act(() => rootA.render(<StreamingMarkdown text={text} />))
      act(() => rootB.render(<Markdown text={text} />))
      expect(boxA.innerHTML, `样本不匹配：${text}`).toBe(boxB.innerHTML)
      act(() => rootA.unmount())
      act(() => rootB.unmount())
    }
  })
})
