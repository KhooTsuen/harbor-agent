import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '@/types/safety'

/* ══════════════════════════════════════════════════════════════
   AG-040：达到执行预算的那三个按钮（真渲染）

   文档：

     Agent 已达到本次任务执行上限。
     [继续] [停止] [调整预算]

   这一组验的是**界面真的给得出这三个**，以及：
     · 没撞预算的任务不许出现「调整预算」（不然每行都多个按钮 = 噪音）
     · 「停止」只在撞预算时才这么叫（平时叫「放弃」）
     · 表单能改并真的存（taskUpdate 收到 budget）
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({ updates: [] as Array<Record<string, unknown>> }))

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return {
    ...actual,
    useRealBackend: false,
    pauseChat: async () => {},
    abortChat: async () => {},
  }
})

vi.mock('@/lib/safetyApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/safetyApi')>()
  return {
    ...actual,
    taskUpdate: async (_id: string, patch: Record<string, unknown>) => {
      h.updates.push(patch)
      return undefined
    },
    taskDiagnose: async () => ({ title: '', status: '', conclusion: '', text: '' }),
  }
})

import { TaskRow } from '../TaskRow'

let container: HTMLDivElement
let root: Root

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: '跑一个长活',
    goal: '跑一个长活',
    status: 'paused',
    mode: 'pair',
    sessionId: 's1',
    projectId: '',
    workdir: 'E:/demo',
    plan: [],
    steps: [],
    checkpoints: [],
    changedFiles: [],
    commands: [],
    changeSetId: '',
    errors: [],
    result: '',
    pausedAt: Date.now(),
    resumeCount: 0,
    createdAt: 1000,
    updatedAt: 4000,
    finishedAt: 0,
    ...patch,
  }
}

function draw(record: TaskRecord): void {
  act(() => {
    root.render(
      <TaskRow
        task={record}
        phases={[]}
        now={9000}
        active={false}
        busy={false}
        onOpen={() => {}}
        onResume={() => {}}
        onGiveUp={() => {}}
      />,
    )
  })
}

const byText = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  h.updates = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AG-040 / 撞了预算那三个按钮', () => {
  it('★ 撞预算：显示出上限、给「继续 / 停止 / 调整预算」', () => {
    draw(
      task({
        pauseReason: 'budget',
        pauseDetail: 'maxSteps',
        budgetHit: { reason: 'maxSteps', label: '轮数上限', used: 50, limit: 50 },
      }),
    )
    const text = container.textContent ?? ''
    expect(text).toContain('已达到轮数上限（50 / 50）')
    expect(byText('继续')).toBeTruthy()
    expect(byText('停止')).toBeTruthy()
    expect(byText('调整预算')).toBeTruthy()
    /* 撞预算时不该再叫「放弃」 */
    expect(byText('放弃')).toBeUndefined()
  })

  it('★ 没撞预算的行不许出现「调整预算」（那是噪音）', () => {
    draw(task({ status: 'paused' }))
    expect(byText('调整预算')).toBeUndefined()
    expect(byText('放弃')).toBeTruthy()
    expect(container.textContent).not.toContain('已达到')
  })

  it('★ 点「调整预算」展开表单，五个字段都在', () => {
    draw(
      task({
        pauseReason: 'budget',
        budgetHit: { reason: 'maxSteps', label: '轮数上限', used: 50, limit: 50 },
        budgetResolved: {
          maxSteps: 50,
          maxToolCalls: 100,
          maxRuntime: 1800,
          maxRetries: 3,
          maxTokens: 100000,
        },
      }),
    )
    act(() => byText('调整预算')?.click())
    for (const label of ['轮数', '工具调用', '运行时长', '自动重试', '本任务 token']) {
      expect(container.querySelector(`input[aria-label="${label}"]`), label).toBeTruthy()
    }
    /* 占位符里写着默认值（用户不用猜） */
    expect(container.querySelector<HTMLInputElement>('input[aria-label="轮数"]')?.placeholder).toBe(
      '50',
    )
    /* 运行时长按分钟显示（1800 秒 → 30） */
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="运行时长"]')?.placeholder,
    ).toBe('30')
  })

  it('★ 改完保存 → 真的把 budget 交上去（按秒存）', async () => {
    draw(
      task({
        pauseReason: 'budget',
        budgetHit: { reason: 'maxSteps', label: '轮数上限', used: 50, limit: 50 },
        budgetResolved: {
          maxSteps: 50,
          maxToolCalls: 100,
          maxRuntime: 1800,
          maxRetries: 3,
          maxTokens: 100000,
        },
      }),
    )
    act(() => byText('调整预算')?.click())

    const setValue = (label: string, value: string) => {
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    }
    act(() => setValue('轮数', '120'))
    act(() => setValue('运行时长', '60'))

    await act(async () => {
      byText('保存')?.click()
    })

    expect(h.updates).toHaveLength(1)
    const budget = (h.updates[0] as { budget: Record<string, number> }).budget
    expect(budget.maxSteps).toBe(120)
    /* 界面上填的是分钟，存的是秒 */
    expect(budget.maxRuntime).toBe(3600)
    /* 没填的不进覆盖（留空 = 用默认） */
    expect(budget.maxTokens).toBeUndefined()
  })

  it('★ AG-041：转圈停下来 → 显示证据 + 「继续 / 停止」（没有「调整预算」）', () => {
    draw(
      task({
        pauseReason: 'loop',
        pauseDetail: 'cycle',
        loopHit: {
          kind: 'cycle',
          period: 2,
          count: 6,
          samples: ['read_file({"path":"a.txt"})', 'run_shell({"command":"ls"})'],
        },
      }),
    )
    const text = container.textContent ?? ''
    expect(text).toContain('检测到重复执行（6 次同类调用）')
    expect(byText('继续')).toBeTruthy()
    expect(byText('停止')).toBeTruthy()
    /* 转圈和预算无关，不该给「调整预算」 */
    expect(byText('调整预算')).toBeUndefined()
    /* 鼠标停上去能看到到底在重复什么 */
    expect(container.querySelector('[title*="read_file"]')).toBeTruthy()
  })

  it('填了乱七八糟的值 → 不提交，只提示', async () => {
    draw(
      task({
        pauseReason: 'budget',
        budgetHit: { reason: 'maxSteps', label: '轮数上限', used: 50, limit: 50 },
      }),
    )
    act(() => byText('调整预算')?.click())
    const input = container.querySelector<HTMLInputElement>('input[aria-label="轮数"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, '-3')
    input?.dispatchEvent(new Event('input', { bubbles: true }))
    await act(async () => {
      byText('保存')?.click()
    })
    expect(h.updates).toHaveLength(0)
  })
})
