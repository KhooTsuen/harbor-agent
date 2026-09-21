import { existsSync, readFileSync } from 'node:fs'
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

  it('★ 任务只在一处显示（AG-030：状态页那份列表已删掉）', () => {
    expect(existsSync(join(SRC, 'components/chat/TaskList.tsx'))).toBe(false)
    const center = readFileSync(join(SRC, 'components/chat/TaskCenter.tsx'), 'utf8')
    expect(center).toContain('useTaskStore((s) => s.tasks)')
  })

  it('★ 分组只渲染非空的，且顶部不再重复一排状态 chips', () => {
    const src = readFileSync(join(SRC, 'components/chat/TaskCenter.tsx'), 'utf8')
    /* 只遍历「活着的」分组 —— 空分组不渲染 */
    expect(src).toContain('activeGroups.map((group) => {')
    expect(src).toMatch(
      /TASK_GROUPS\.filter\(\(group\) => \(groups\.get\(group\.status\)\?\.length \?\? 0\) > 0\)/,
    )
    /*
     * 分组标题里已经有「进行中 · 1」—— 顶部那排 chips 不能再把它重复一遍。
     * 直接断言「这个文件里没有胶囊样式」：任务中心里出现胶囊，基本就意味着
     * 又在把状态/计数摆一遍（变异测试验证过：加回 chips 这条会红）。
     */
    expect(src).not.toContain('rounded-pill')
  })

  it('全量任务与恢复清单一次刷新，后端仍是唯一真相源', () => {
    const src = readFileSync(join(SRC, 'stores/useTaskStore.ts'), 'utf8')
    expect(src).toContain('taskList({ limit: 200, workdir })')
    expect(src).toContain('taskRecovery(workdir)')
  })

  it('任务标签能作为「上次右栏标签」恢复', () => {
    const settings = readFileSync(join(SRC, 'stores/useSettingsStore.ts'), 'utf8')
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8')
    expect(settings).toContain("s.lastRightTab === 'tasks'")
    expect(app).toContain('setActiveRightTab(settings.lastRightTab)')
    expect(app).toContain('if (rightTabRestored) updateSettings')
  })

  it('★ 继续 / 放弃 搬到了任务行，接的是真动作', () => {
    const row = readFileSync(join(SRC, 'components/chat/TaskRow.tsx'), 'utf8')
    const center = readFileSync(join(SRC, 'components/chat/TaskCenter.tsx'), 'utf8')
    expect(row).toContain('继续')
    expect(row).toContain('放弃')
    /* 继续 → resumeTask（复用原任务，不新建）；放弃 → taskUpdate cancelled */
    expect(center).toContain('useThreadStore.getState().resumeTask(task.id)')
    expect(center).toContain("taskUpdate(task.id, { status: 'cancelled' })")
  })

  it('★ 只有可恢复/未结束的任务才出现对应按钮', () => {
    const row = readFileSync(join(SRC, 'components/chat/TaskRow.tsx'), 'utf8')
    expect(row).toMatch(/RESUMABLE.*=.*\['paused', 'waiting_user'\]/s)
    expect(row).toMatch(/CLOSABLE.*=.*\['running', 'paused', 'waiting_user', 'failed'\]/s)
  })

  it('★ 撤销改动也在任务中心（横幅撤掉后唯一入口）', () => {
    const center = readFileSync(join(SRC, 'components/chat/TaskCenter.tsx'), 'utf8')
    expect(center).toContain('changesetRollback(changeset.id)')
    expect(center).toContain('可撤销的改动')
    const store = readFileSync(join(SRC, 'stores/useTaskStore.ts'), 'utf8')
    expect(store).toContain('changesetList({ limit: 5 })')
    expect(store).toContain("c.status === 'committed' && c.fileCount > 0")
  })

  it('★ 启动提示指向任务中心（不再让人去顶上看横幅）', () => {
    const src = readFileSync(join(SRC, 'hooks/useAppBootstrap.ts'), 'utf8')
    /* toast 的两个分支都要指到新家（文件里注释也会提到，所以不看次数） */
    expect(src).toContain('右栏「任务」里可以接着做')
    expect(src).toContain('右栏「任务」标签里可以接着做')
  })
})
