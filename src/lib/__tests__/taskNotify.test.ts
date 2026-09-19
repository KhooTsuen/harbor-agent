import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '@/types/safety'
import { endNotice, shouldNotifyEnd } from '../taskNotify'

/* AG-029：通知内容与「该不该打扰」的纯函数部分 */

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: '重构执行引擎',
    goal: '重构执行引擎',
    status: 'completed',
    mode: 'pair',
    sessionId: 'session-1',
    projectId: '',
    workdir: 'E:/demo',
    plan: ['[x] 分析'],
    steps: [],
    checkpoints: [],
    changedFiles: [
      { path: 'src/a.ts', at: 1 },
      { path: 'src/b.ts', at: 2 },
      { path: 'src/c.ts', at: 3 },
      { path: 'src/d.ts', at: 4 },
    ],
    commands: [],
    changeSetId: '',
    errors: [],
    result: '测试通过\n其余细节……',
    createdAt: 1000,
    updatedAt: 4000,
    finishedAt: 4000,
    ...patch,
  }
}

describe('AG-029 / 通知内容', () => {
  it('完成：名字 + 改了 N 个文件 + 结果第一行', () => {
    const notice = endNotice('completed', task())
    expect(notice?.kind).toBe('success')
    expect(notice?.title).toBe('后台任务完成')
    expect(notice?.description).toBe('「重构执行引擎」\n已修改 4 个文件\n测试通过')
  })

  it('没改文件也说实话', () => {
    expect(endNotice('completed', task({ changedFiles: [] }))?.description).toContain(
      '没有改动文件',
    )
  })

  it('失败：说错误原因（没有结果时）', () => {
    const notice = endNotice(
      'failed',
      task({ status: 'failed', result: '', errors: [{ at: 1, message: 'npm test 退出码 1' }] }),
    )
    expect(notice?.kind).toBe('error')
    expect(notice?.description).toContain('npm test 退出码 1')
  })

  it('没有任务台账也能出通知（名字退成「未命名任务」）', () => {
    const notice = endNotice('completed', undefined)
    expect(notice?.description).toBe('「未命名任务」')
  })

  it('★ 用户自己按的停止不通知（那是他刚做的事，再弹一条是噪音）', () => {
    expect(endNotice('cancelled', task({ status: 'cancelled' }))).toBeNull()
  })

  it('非终态一律不出通知', () => {
    for (const phase of ['thinking', 'executing', 'paused', 'waiting_user', 'idle'] as const) {
      expect(endNotice(phase, task())).toBeNull()
    }
  })
})

describe('AG-029 / 该不该打扰（不抢焦点）', () => {
  it('正在看这条对话 + 窗口在前台 → 不打扰', () => {
    expect(shouldNotifyEnd({ threadId: 'a', activeThreadId: 'a', windowFocused: true })).toBe(false)
  })

  it('别的对话结束了 → 通知', () => {
    expect(shouldNotifyEnd({ threadId: 'b', activeThreadId: 'a', windowFocused: true })).toBe(true)
  })

  it('★ 窗口在后台（用户切到别的应用了）→ 哪怕是当前对话也通知', () => {
    expect(shouldNotifyEnd({ threadId: 'a', activeThreadId: 'a', windowFocused: false })).toBe(true)
  })
})
