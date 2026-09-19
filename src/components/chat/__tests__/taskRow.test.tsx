import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TaskRecord } from '@/types/safety'
import { TaskRow } from '../TaskRow'

/* ══════════════════════════════════════════════════════════════
   任务行（AG-028 收尾：横幅撤掉、动作搬进任务中心）

   为什么要真渲染而不是源码守卫：先写的那版守卫断言的是
   `toContain('继续')` —— **注释里的字也算**，把「继续」按钮删掉照样绿
   （变异测试①没抓住，正是这个项目反复踩的那个坑）。
   这里改成真的挂载、真的点，断言回调被调用。
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

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: '重构执行引擎',
    goal: '重构执行引擎',
    status: 'paused',
    mode: 'pair',
    sessionId: 'session-1',
    projectId: '',
    workdir: 'E:/demo',
    plan: ['[x] 分析', '[ ] 修改'],
    steps: [],
    checkpoints: [],
    changedFiles: [],
    commands: [],
    changeSetId: '',
    errors: [],
    result: '',
    createdAt: 1000,
    updatedAt: 4000,
    finishedAt: 0,
    ...patch,
  }
}

function draw(
  record: TaskRecord,
  handlers: { resume?: () => void; giveUp?: () => void; open?: () => void } = {},
) {
  act(() => {
    root.render(
      <TaskRow
        task={record}
        phases={[]}
        now={9000}
        active={false}
        busy={false}
        onOpen={handlers.open ?? (() => {})}
        onResume={handlers.resume ?? (() => {})}
        onGiveUp={handlers.giveUp ?? (() => {})}
      />,
    )
  })
  return container
}

function button(el: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
}

describe('AG-028 / 任务行（真渲染）', () => {
  it('★ 暂停的任务有「继续」，点下去真的回调', () => {
    let resumed = 0
    const el = draw(task({ status: 'paused' }), {
      resume: () => {
        resumed += 1
      },
    })
    const btn = button(el, '继续')
    expect(btn).toBeTruthy()
    act(() => btn?.click())
    expect(resumed).toBe(1)
  })

  it('★ 点「放弃」也真的回调', () => {
    let gave = 0
    const el = draw(task({ status: 'paused' }), {
      giveUp: () => {
        gave += 1
      },
    })
    const btn = button(el, '放弃')
    expect(btn).toBeTruthy()
    act(() => btn?.click())
    expect(gave).toBe(1)
  })

  it('运行中的任务不给「继续」（那会平白再起一轮），但可以放弃', () => {
    const el = draw(task({ status: 'running' }))
    expect(button(el, '继续')).toBeUndefined()
    expect(button(el, '放弃')).toBeTruthy()
  })

  it('已经结束的任务不再给这两个按钮', () => {
    for (const status of ['completed', 'cancelled'] as const) {
      const el = draw(task({ status }))
      expect(button(el, '继续')).toBeUndefined()
      expect(button(el, '放弃')).toBeUndefined()
    }
  })

  it('★ 点任务名回到它属于的那条对话', () => {
    let opened = 0
    const el = draw(task(), {
      open: () => {
        opened += 1
      },
    })
    act(() => {
      el.querySelector<HTMLButtonElement>('button[aria-label^="任务："]')?.click()
    })
    expect(opened).toBe(1)
  })

  it('★ 默认不显示运行细节（AG-030：Tool 数 / 历时 / 更新时间压进详情里）', () => {
    const el = draw(task({ steps: [{ at: 1, tool: 'read_file', ok: true, ms: 5, summary: 'x' }] }))
    expect(el.textContent).not.toContain('Tool')
    expect(el.textContent).not.toContain('历时')
    expect(el.textContent).not.toContain('更新')

    act(() => button(el, '详情')?.click())
    expect(el.textContent).toContain('1 Tool')
    expect(el.textContent).toContain('历时')
    expect(el.textContent).toContain('更新')
  })

  it('★ 零值不显示（「改了 0 个文件」是噪音）', () => {
    const el = draw(task({ changedFiles: [] }))
    expect(el.textContent).not.toContain('改了')

    const el2 = draw(task({ changedFiles: [{ path: 'a.ts', at: 1 }] }))
    expect(el2.textContent).toContain('改了 1 个文件')
  })

  it('★ 有失败时把「N 次失败」摆出来（异常要突出）', () => {
    const el = draw(task({ status: 'failed', errors: [{ at: 1, message: '炸了' }] }))
    expect(el.textContent).toContain('1 次失败')
  })

  it('计划与时间线只在展开「详情」后出现', () => {
    /* 当前步骤在收起时本来就显示（那是 AG-028 要求的一行），
       所以用一个只有时间线里才会出现的 Tool 摘要当探针。 */
    const el = draw(
      task({ steps: [{ at: 2, tool: 'read_file', ok: true, ms: 5, summary: '读了配置文件' }] }),
    )
    expect(el.textContent).not.toContain('读了配置文件')
    const detail = button(el, '详情')
    expect(detail).toBeTruthy()
    act(() => detail?.click())
    expect(el.textContent).toContain('读了配置文件')
  })
})
