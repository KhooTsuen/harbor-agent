import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PermissionBar } from '../PermissionBar'
import { useUIStore } from '@/stores/useUIStore'
import type { PermissionRequest } from '@/types'

/* ══════════════════════════════════════════════════════════════
   命令类确认条（贴输入区那个）

   它管的是「允许本次」这一步 —— 内核等着一个**明确的答复**才会动手，
   所以这里要钉住的不是长相，而是四件事：

     ① 只有明确点按钮才算答复（点别处、按 Esc 都不算）
     ② 「允许」回的是 true、「取消」回的是 false，而且各自只回一次
     ③ 不是内核那种确认（删对话/清任务）时**不出现** —— 那些走模态框，
        两边都渲染会叠出两套确认 UI
     ④ 该给用户看的东西要在：命令/写文件的影响预览、Diff 入口

   为什么真渲染：这个项目反复踩过「源码守卫断言到注释里的字」的坑。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

const answered: boolean[] = []
const cancelled: string[] = []

function makeRequest(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    kind: 'run-command',
    title: 'Agent 准备执行命令',
    description: '会在工作目录里跑一条命令',
    impact: ['在工作目录执行：E:/demo', '命令：npm test'],
    confirmText: '允许本次',
    onConfirm: () => answered.push(true),
    onCancel: () => cancelled.push('cancelled'),
    ...over,
  } as PermissionRequest
}

beforeEach(() => {
  answered.length = 0
  cancelled.length = 0
  useUIStore.setState({ permission: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function mount(request: PermissionRequest | null): void {
  useUIStore.setState({ permission: request })
  act(() => root.render(<PermissionBar />))
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) =>
    (b.textContent || '').trim().includes(text),
  ) as HTMLButtonElement | undefined
}

describe('确认条 / 什么时候出现', () => {
  it('没有确认请求时不渲染', () => {
    mount(null)
    expect(container.querySelector('[aria-label="等待确认"]')).toBeNull()
  })

  it('★ 内核的命令确认 → 出现', () => {
    mount(makeRequest())
    expect(container.querySelector('[aria-label="等待确认"]')).not.toBeNull()
    expect(container.textContent).toContain('Agent 准备执行命令')
  })

  it('★ 应用自己的危险操作（删对话/清任务）→ 不出现（那些走模态框，不然叠两套）', () => {
    mount(makeRequest({ kind: 'delete-thread', title: '删掉这条对话？' }))
    expect(container.querySelector('[aria-label="等待确认"]')).toBeNull()
  })
})

describe('确认条 / 答复的语义', () => {
  it('★ 「允许本次」→ onConfirm，且只回一次', async () => {
    mount(makeRequest())
    await act(async () => {
      buttonByText('允许本次')?.click()
    })
    expect(answered).toEqual([true])
    expect(cancelled).toEqual([])
    /* 点完就收起来，不能再答复第二次 */
    expect(useUIStore.getState().permission).toBeNull()
    expect(container.querySelector('[aria-label="等待确认"]')).toBeNull()
  })

  it('★ 「取消」→ onCancel（主进程不能一直等着）', async () => {
    mount(makeRequest())
    await act(async () => {
      buttonByText('取消')?.click()
    })
    expect(cancelled).toEqual(['cancelled'])
    expect(answered).toEqual([])
    expect(useUIStore.getState().permission).toBeNull()
  })

  it('★ 自定义按钮文案（confirmText）照用', () => {
    mount(makeRequest({ confirmText: '允许这次执行' }))
    expect(buttonByText('允许这次执行')).toBeTruthy()
  })

  it('没给 confirmText 时退回「允许本次」', () => {
    mount(makeRequest({ confirmText: '' }))
    expect(buttonByText('允许本次')).toBeTruthy()
  })
})

describe('确认条 / 该给用户看的要有', () => {
  it('★ 影响预览（Dry Run）显示出来', () => {
    mount(makeRequest())
    expect(container.textContent).toContain('影响预览')
    expect(container.textContent).toContain('命令：npm test')
  })

  it('★ 写文件那条路：有 Diff 就给「查看 Diff」，点开才展开', async () => {
    mount(
      makeRequest({
        kind: 'run-command',
        title: 'Agent 准备修改文件',
        impact: ['写入文件：E:/demo/README.md'],
        diff: [
          {
            path: 'README.md',
            additions: 1,
            deletions: 1,
            hunks: [
              {
                header: '@@ -1 +1 @@',
                lines: [
                  { type: 'remove', content: '旧的一行' },
                  { type: 'add', content: '新的一行' },
                ],
              },
            ],
          },
        ],
      }),
    )
    expect(container.textContent).toContain('会改 1 个文件')
    expect(container.textContent).not.toContain('新的一行')
    await act(async () => {
      buttonByText('查看 Diff')?.click()
    })
    expect(container.textContent).toContain('新的一行')
  })
})

describe('确认条 / 不抢焦点、不误判', () => {
  it('★ 它不是 aria-modal（不遮罩、不抓焦点 —— 用户还能继续打字/看消息）', () => {
    mount(makeRequest())
    const bar = container.querySelector('[aria-label="等待确认"]')
    expect(bar?.getAttribute('aria-modal')).toBeNull()
  })

  it('点确认条自己（不是按钮）不会答复', () => {
    mount(makeRequest())
    act(() => {
      container
        .querySelector('[aria-label="等待确认"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(answered).toEqual([])
    expect(cancelled).toEqual([])
  })
})
