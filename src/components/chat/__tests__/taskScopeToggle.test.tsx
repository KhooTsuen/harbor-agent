import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskCenter } from '../TaskCenter'
import { useSettingsStore } from '@/stores/useSettingsStore'

/* ══════════════════════════════════════════════════════════════
   任务中心的「看哪些任务」开关

   为什么真点而不是源码守卫：这个项目反复踩过「注释里的字也算命中」的坑
   （把按钮删掉、守卫照样绿）。所以这里真的挂载、真的点，断言 store 里的值变了、
   而且**传给主进程的 workdir 跟着变** —— 那才是过滤真正生效的地方。
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ limit?: number; workdir?: string }>,
  /* 默认给一条任务：没有任务时组件只渲染空状态，标题栏那个开关就不存在了 */
  rows: true,
}))

const oneTask = () => ({
  id: 'task_test',
  title: '测试任务',
  goal: '测试',
  status: 'completed' as const,
  sessionId: 's1',
  workdir: 'E:/demo',
  plan: [],
  planVersions: [],
  steps: [],
  checkpoints: [],
  changedFiles: [],
  commands: [],
  errors: [],
  result: '做完了',
  tokens: 0,
  retries: 0,
  createdAt: 1,
  updatedAt: 2,
})

vi.mock('@/lib/safetyApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/safetyApi')>()
  return {
    ...actual,
    taskList: async (options?: { limit?: number; workdir?: string }) => {
      h.calls.push(options ?? {})
      return h.rows ? [oneTask()] : []
    },
    taskRecovery: async () => [],
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  /* 这个 store 是持久化的，跑测试时会被上一条用例污染 —— 每次先摆正 */
  useSettingsStore.getState().updateSettings({ taskScope: 'project' })
  h.calls.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function findToggle(): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find((b) =>
    (b.getAttribute('aria-label') || '').includes('项目'),
  )
  if (!btn) {
    const labels = [...container.querySelectorAll('button')]
      .map((b) => b.getAttribute('aria-label') || b.textContent)
      .join(' / ')
    throw new Error(`没找到范围开关；按钮有：${labels}`)
  }
  return btn as HTMLButtonElement
}

describe('任务中心 / 看哪些任务', () => {
  /** 组件等 store 的 loaded 才渲染内容，所以首帧要等异步刷新走完 */
  async function mount(): Promise<void> {
    await act(async () => {
      root.render(<TaskCenter />)
    })
  }

  it('默认「只看当前项目」（跟已上线行为一致）', async () => {
    await mount()
    expect(useSettingsStore.getState().settings.taskScope).toBe('project')
    expect(findToggle().getAttribute('aria-label')).toBe('看全部项目')
  })

  it('★ 点一下切成「看全部项目」，并把空 workdir 传下去（= 主进程不过滤）', async () => {
    await mount()
    h.calls.length = 0

    await act(async () => {
      findToggle().click()
    })

    expect(useSettingsStore.getState().settings.taskScope).toBe('all')
    expect(h.calls.length).toBeGreaterThan(0)
    expect(h.calls.every((c) => !c.workdir)).toBe(true)
  })

  it('★ 切回「只看当前项目」时按钮文案跟着变回来', async () => {
    await mount()
    await act(async () => {
      findToggle().click()
    })
    expect(findToggle().getAttribute('aria-label')).toBe('只看当前项目')
  })

  it('★ 这个项目没任务时，空状态里也给出口（否则发现不了别的项目有）', async () => {
    h.rows = false
    await mount()
    const btn = [...container.querySelectorAll('button')].find((b) =>
      (b.getAttribute('aria-label') || '').includes('看全部项目'),
    )
    expect(btn).toBeTruthy()
    await act(async () => {
      ;(btn as HTMLButtonElement).click()
    })
    expect(useSettingsStore.getState().settings.taskScope).toBe('all')
  })
})
