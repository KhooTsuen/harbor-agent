import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '@/types/safety'

/* ══════════════════════════════════════════════════════════════
   任务面板里的删除（用户要的按钮）

   两条规矩，一条在界面、一条在内核：
     · 界面：正在跑 / 等确认的任务**不给删除按钮**（那时该按「停止」）
     · 内核：真删的时候也会拦（`removeSafe` / `removeMany`）—— 见 47-purge 组
   这里测界面这一半：按钮该出现的时候出现、不该出现的时候不出现、点了会回调。
   ══════════════════════════════════════════════════════════════ */

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return { ...actual, useRealBackend: false }
})

vi.mock('@/lib/safetyApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/safetyApi')>()
  return {
    ...actual,
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
    status: 'completed',
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
    pausedAt: 0,
    resumeCount: 0,
    createdAt: 1000,
    updatedAt: 4000,
    finishedAt: 5000,
    ...patch,
  }
}

function draw(record: TaskRecord, onDelete: () => void): void {
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
        onDelete={onDelete}
      />,
    )
  })
}

const delBtn = () => document.querySelector('[aria-label="删除这条记录"]')

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('任务面板 / 删除按钮', () => {
  it('★ 已完成的任务有删除按钮，点了会回调', () => {
    const onClick = vi.fn()
    draw(task({ status: 'completed' }), onClick)
    const button = delBtn() as HTMLButtonElement | null
    expect(button).toBeTruthy()
    act(() => button?.click())
    expect(onClick).toHaveBeenCalled()
  })

  it('★ 正在跑的任务没有删除按钮（该按「停止」）', () => {
    draw(task({ status: 'running' }), () => {})
    expect(delBtn()).toBeNull()
  })

  it('★ 等你确认的任务也没有删除按钮', () => {
    draw(task({ status: 'waiting_user' }), () => {})
    expect(delBtn()).toBeNull()
  })

  it('已取消 / 已暂停的都能删', () => {
    draw(task({ status: 'cancelled' }), () => {})
    expect(delBtn()).toBeTruthy()
    act(() => root.unmount())
    root = createRoot(container)
    draw(task({ status: 'paused' }), () => {})
    expect(delBtn()).toBeTruthy()
  })

  it('★「清空」只出现在已结束的分组上（源码守卫）', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/chat/TaskCenter.tsx'), 'utf8')
    /* 在跑 / 等确认的分组要跳过「清空」按钮 */
    expect(src).toContain('LIVE_GROUPS.includes(group.status)')
    /* 清空走批量删，且把「跳过几条」说出来 */
    expect(src).toContain('taskRemoveMany({ statuses: [status] })')
    expect(src).toContain('跳过')
  })
})
