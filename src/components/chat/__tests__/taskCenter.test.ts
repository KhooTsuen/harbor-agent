import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '@/types/safety'
import {
  TASK_GROUPS,
  currentStepOf,
  elapsedMs,
  formatDuration,
  groupTasks,
  taskProgress,
} from '../taskCenterModel'

const SRC = join(__dirname, '..', '..', '..')

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: '优化执行引擎',
    goal: '优化执行引擎',
    status: 'running',
    mode: 'pair',
    sessionId: 'session-1',
    projectId: '',
    workdir: 'E:/demo',
    plan: ['[x] 分析', '[ ] 修改', '[ ] 测试'],
    steps: [{ at: 1100, tool: 'read_file', ok: true, ms: 20, summary: '读文件' }],
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

describe('AG-028 / 任务中心数据', () => {
  it('六个状态按需求顺序定义', () => {
    expect(TASK_GROUPS.map((item) => item.status)).toEqual([
      'running',
      'paused',
      'waiting_user',
      'failed',
      'completed',
      'cancelled',
    ])
  })

  it('计划进度只数 [x]', () => {
    expect(taskProgress(task())).toEqual({ done: 1, total: 3 })
  })

  it('当前步骤 = 第一条没完成的计划', () => {
    expect(currentStepOf(task())).toBe('修改')
  })

  it('完成 / 失败不假装还有当前步骤', () => {
    expect(currentStepOf(task({ status: 'completed', plan: ['[x] 一'] }))).toBe('全部计划已完成')
    expect(
      currentStepOf(task({ status: 'failed', plan: [], errors: [{ at: 2, message: '测试失败' }] })),
    ).toBe('测试失败')
  })

  it('Running 用当前时钟，结束任务停在 finishedAt', () => {
    expect(elapsedMs(task(), 9000)).toBe(8000)
    expect(elapsedMs(task({ status: 'completed', finishedAt: 5000 }), 9000)).toBe(4000)
  })

  it('时长格式不会一直堆秒数', () => {
    expect(formatDuration(9000)).toBe('9秒')
    expect(formatDuration(125000)).toBe('2分 05秒')
    expect(formatDuration(3720000)).toBe('1时 02分')
  })

  it('任务按状态分类，不复制任务对象', () => {
    const running = task()
    const paused = task({ id: 'task-2', status: 'paused' })
    const groups = groupTasks([running, paused])
    expect(groups.get('running')).toEqual([running])
    expect(groups.get('paused')).toEqual([paused])
    expect(groups.get('completed')).toEqual([])
  })
})

describe('AG-028 / 接线守卫', () => {
  it('右栏有独立「任务」标签并挂 TaskCenter', () => {
    const src = readFileSync(join(SRC, 'components/layout/RightPanel.tsx'), 'utf8')
    expect(src).toContain("{ id: 'tasks', label: '任务'")
    expect(src).toContain("activeRightTab === 'tasks' ? <TaskCenter />")
  })

  it('任务中心点击任务会切回对应线程', () => {
    const src = readFileSync(join(SRC, 'components/chat/TaskCenter.tsx'), 'utf8')
    expect(src).toContain('setActiveThread(task.sessionId)')
  })

  it('状态页不再单独调用 taskList（共用 store）', () => {
    const src = readFileSync(join(SRC, 'components/chat/TaskList.tsx'), 'utf8')
    expect(src).not.toContain("from '@/lib/safetyApi'")
    expect(src).toContain('useTaskStore((s) => s.tasks)')
  })

  it('全量任务与恢复清单一次刷新，后端仍是唯一真相源', () => {
    const src = readFileSync(join(SRC, 'stores/useTaskStore.ts'), 'utf8')
    expect(src).toContain('taskList({ limit: 200 })')
    expect(src).toContain('taskRecovery()')
  })

  it('任务标签能作为「上次右栏标签」恢复', () => {
    const settings = readFileSync(join(SRC, 'stores/useSettingsStore.ts'), 'utf8')
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8')
    expect(settings).toContain("s.lastRightTab === 'tasks'")
    expect(app).toContain('setActiveRightTab(settings.lastRightTab)')
    expect(app).toContain('if (rightTabRestored) updateSettings')
  })
})
