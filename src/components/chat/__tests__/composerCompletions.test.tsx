import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCompletions } from '../composer/useCompletions'

/* ══════════════════════════════════════════════════════════════
   输入框补全（2026-10-04，小尾巴 #2 抽出来时钉的）

   原来这段逻辑长在 `Composer.tsx` 里（那个文件只剩 5 行余量）。抽成 hook 时
   顺手把三条行为钉住 —— 它们都很容易在后续改动里被破坏：
     · 只有**行尾**的 `/xxx`、`@xxx` 才弹菜单（正文中间的 `@` 不弹）；
     · 选中后把 `[/@]xxx` 换成它并留一个空格；
     · 文件清单读不到时（IPC 失败/网页预览）退回备选清单，不弹空菜单。
   ══════════════════════════════════════════════════════════════ */

const fsTree = vi.fn()
vi.mock('@/lib/fsApi', () => ({ fsTree: () => fsTree() }))

let container: HTMLDivElement
let root: Root
let latest: ReturnType<typeof useCompletions>
let typed: string[] = []

function Harness({ text }: { text: string }) {
  latest = useCompletions(text, (v) => typed.push(v))
  return (
    <button type="button" onClick={() => latest.syncFromText(text)}>
      同步
    </button>
  )
}

beforeEach(() => {
  typed = []
  fsTree.mockResolvedValue({ ok: false })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const draw = (text: string) => act(() => root.render(<Harness text={text} />))

describe('补全', () => {
  it('打 / 出命令，打 @ 出行尾候选', async () => {
    await act(async () => {
      draw('/')
    })
    await act(async () => {
      latest.syncFromText('/')
    })
    expect(latest.open).toBe(true)
    expect(latest.options.length).toBeGreaterThan(0)
    expect(latest.options[0]).toHaveProperty('cmd')

    await act(async () => {
      draw('前面说的话 @')
    })
    await act(async () => {
      latest.syncFromText('前面说的话 @')
    })
    expect(latest.open).toBe(true)
    expect(latest.options.every((o) => 'name' in o)).toBe(true)
  })

  it('★ 正文中间的 @ 不弹菜单（只在行尾触发）', () => {
    draw('发给 @张三 说一声')
    expect(latest.open).toBe(false)
    expect(latest.options).toEqual([])
  })

  it('★ 选中后替换掉那段标记并留一个空格', () => {
    draw('/comp')
    act(() => latest.apply('/compact'))
    expect(typed[typed.length - 1]).toBe('/compact ')
    expect(latest.open).toBe(false)
  })

  it('关掉菜单（Esc/Tab）之后就真关了', () => {
    draw('/')
    act(() => latest.syncFromText('/'))
    act(() => latest.close())
    expect(latest.open).toBe(false)
  })

  it('文件清单读不到时退回备选清单（不是空菜单）', async () => {
    await act(async () => {
      draw('@')
    })
    await act(async () => {
      latest.syncFromText('@')
    })
    expect(latest.options.length).toBeGreaterThan(0)
  })
})
