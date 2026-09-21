import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiffFile } from '@/types'
import { useUIStore } from '@/stores/useUIStore'
import { PermissionDialog } from '../PermissionDialog'

/* ══════════════════════════════════════════════════════════════
   AG-036：确认弹窗里的「查看 Diff」

   文档两处都写了这个按钮（AG-013 / AG-014）：
     `[允许本次] [查看 Diff] [拒绝]`

   而弹窗原来只有一行文字摘要（`写文件 x（1291 字节）`）——
   点「允许」等于闭眼签。这里真渲染验四件事：
     · 有 diff 时**默认折叠**（用户拍板要折叠），点开才看内容
     · 没有 diff 的确认（跑命令）不出现这个入口
     · 「文件太大 / 找不到原文」这类说明照实显示
     · 取消仍然会把「拒绝」回给主进程（不然它一直挂着等超时）
   ══════════════════════════════════════════════════════════════ */

const DIFF: DiffFile[] = [
  {
    path: 'E:/demo/README.md',
    additions: 1,
    deletions: 1,
    hunks: [
      {
        header: '@@ -1,3 +1,3 @@',
        lines: [
          { type: 'context', content: '第一行', oldLineNumber: 1, newLineNumber: 1 },
          { type: 'remove', content: '旧内容', oldLineNumber: 2 },
          { type: 'add', content: '新内容独有', newLineNumber: 2 },
        ],
      },
    ],
  },
]

let container: HTMLDivElement
let root: Root

function show(
  patch: Partial<ReturnType<typeof useUIStore.getState>['permission']> = {},
): HTMLDivElement {
  const onCancel = patch?.onCancel ?? (() => {})
  act(() => {
    useUIStore.getState().askPermission({
      kind: 'delete-thread',
      title: 'Agent 准备修改文件',
      description: '写文件 README.md',
      confirmText: '允许本次',
      danger: false,
      onConfirm: () => {},
      onCancel,
      ...patch,
    })
  })
  act(() => root.render(<PermissionDialog />))
  return container
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useUIStore.setState({ permission: null })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AG-036 / 确认弹窗里的 Diff', () => {
  it('★ 有 diff 时默认折叠：看得到「+1 −1」和按钮，看不到内容', () => {
    show({ diff: DIFF })
    expect(container.textContent).toContain('会改 1 个文件')
    expect(container.textContent).toContain('+1')
    expect(container.textContent).toContain('−1')
    expect(button('查看 Diff')).toBeTruthy()
    /* 内容（那两行）不该先出现 */
    expect(container.textContent).not.toContain('新内容独有')
    expect(container.textContent).not.toContain('旧内容')
  })

  it('★ 点「查看 Diff」→ 内容出来；再点收起', () => {
    show({ diff: DIFF })
    act(() => button('查看 Diff')?.click())
    expect(container.textContent).toContain('新内容独有')
    expect(container.textContent).toContain('旧内容')
    expect(button('收起')).toBeTruthy()
    act(() => button('收起')?.click())
    expect(container.textContent).not.toContain('新内容独有')
  })

  it('没有 diff 的确认（跑命令）不出现「查看 Diff」', () => {
    show({ description: '执行命令：rm -rf build' })
    expect(container.textContent).toContain('rm -rf build')
    expect(container.textContent).not.toContain('会改')
    expect(button('查看 Diff')).toBeUndefined()
  })

  it('★ 算不出 diff 时把原因写出来（文件太大 / 找不到原文）', () => {
    show({ diff: [], diffNote: '文件约 2048 KB，太大就不预览了' })
    expect(container.textContent).toContain('太大就不预览了')
    expect(button('查看 Diff')).toBeUndefined()
  })

  it('影响预览显示目标和副作用说明', () => {
    show({ impact: ['写入文件：E:/demo/a.txt', '改动会进入变更事务'] })
    expect(container.textContent).toContain('影响预览')
    expect(container.textContent).toContain('写入文件：E:/demo/a.txt')
    expect(container.textContent).toContain('改动会进入变更事务')
  })
  it('「查看 Diff」在弹窗上，不是替代允许/取消', () => {
    show({ diff: DIFF })
    expect(button('允许本次')).toBeTruthy()
    expect(button('取消')).toBeTruthy()
  })

  it('★ 点取消会把「拒绝」回给主进程（否则它一直等到超时）', () => {
    let cancelled = 0
    show({ diff: DIFF, onCancel: () => (cancelled += 1) })
    act(() => button('取消')?.click())
    expect(cancelled).toBe(1)
  })
})
