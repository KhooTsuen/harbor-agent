import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '@/types/safety'

/* ══════════════════════════════════════════════════════════════
   AG-042：控制台（真渲染）

   文档要一屏：任务 / 状态 / 当前步骤 / 运行时间 / Tool Calls / Retry / 权限 / 模型 / Token，
   [Pause] [Stop] [查看计划] [查看 Tool] [查看 Diff] [调整权限]。

   内核那一半（数字要真的记进台账）在 `scripts/selftest/groups/43-console.mjs`；
   这里只管**界面真的给得出来**，以及两条容易做错的：
     · 默认折叠（AG-030：没人看的时候别占地方）
     · 已经跑完的任务不给「暂停 / 停止」（没得停）
   ══════════════════════════════════════════════════════════════ */

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
    taskUpdate: async () => undefined,
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

/** 前 n 个字匹配 —— 控制台那个按钮的文字后面还带着汇总（「控制台1 Tool · 8秒」） */
const byPrefix = (prefix: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(prefix))

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AG-042 / 控制台', () => {
  it('★ 八项状态 + 六个动作都在（默认折叠）', () => {
    draw(
      task({
        status: 'running',
        tokens: 42_000,
        retries: 1,
        model: 'deepseek-flash',
        steps: [{ at: 1, tool: 'read_file', ok: true, ms: 5, summary: 'x' }],
        budgetResolved: {
          maxSteps: 50,
          maxToolCalls: 100,
          maxRuntime: 1800,
          maxRetries: 3,
          maxTokens: 100000,
        },
      }),
    )
    act(() => byText('详情')?.click())
    /* 默认折叠：只有一行「控制台」汇总 */
    expect(container.textContent).toContain('控制台')
    expect(container.textContent).not.toContain('Tool Calls')

    act(() => byPrefix('控制台')?.click())
    const text = container.textContent ?? ''
    for (const label of [
      '状态',
      '当前步骤',
      '运行时间',
      'Tool Calls',
      'Retry',
      '权限',
      '模型',
      'Token',
    ]) {
      expect(text, label).toContain(label)
    }
    /* 数字真的显示出来（不是「—」） */
    expect(text).toContain('42K')
    /* 「重试 1 次」—— 分母是单个工具的上限，不写成「1 / 3」（会误导） */
    expect(text).toContain('1 次')
    expect(text).toContain('deepseek-flash')
    /*
     * ★ 当前步骤只用计划里的下一步：计划空着就写「（没有计划）」，
     *   不能退到「最近一步的摘要」（那是 read_file 的文件内容 —— 真机上很难看）
     */
    expect(container.textContent).toContain('（没有计划）')
    /* 六个动作 */
    for (const label of ['暂停', '停止', '查看 Diff', '查看 Tool', '调整权限']) {
      expect(byText(label), label).toBeTruthy()
    }
  })

  it('★ 计划全做完 → 写「计划已做完」，不写「（没有计划）」', () => {
    draw(task({ status: 'completed', plan: ['[x] 第一步', '[x] 第二步'] }))
    act(() => byText('详情')?.click())
    act(() => byPrefix('控制台')?.click())
    const text = container.textContent ?? ''
    expect(text).toContain('计划已做完')
    expect(text).not.toContain('（没有计划）')
  })

  it('★ 跑完的任务不给「暂停 / 停止」（没得停）', () => {
    draw(task({ status: 'completed' }))
    act(() => byText('详情')?.click())
    act(() => byPrefix('控制台')?.click())
    expect(byText('暂停')).toBeUndefined()
    expect(byText('停止')).toBeUndefined()
    /* 只读的那几个照旧有 */
    expect(byText('查看 Diff')).toBeTruthy()
    expect(byText('查看 Tool')).toBeTruthy()
  })
})
