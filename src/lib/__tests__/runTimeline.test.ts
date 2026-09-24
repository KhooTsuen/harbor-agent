import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '@/types/safety'
import { buildRunTimeline } from '../runTimeline'

/* ══════════════════════════════════════════════════════════════
   Run Inspector 的时间线（AG-048）

   三条要钉死的：三类都进得来且按时间排好 / 缺时间戳不许炸 /
   同一时刻顺序不抖。数据全在 `TaskRecord` 里，这里只喂纯对象。
   ══════════════════════════════════════════════════════════════ */

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
    plan: [],
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

describe('AG-048 / 三类数据合成一条线', () => {
  it('工具 / 错误 / 检查点三类都进得来，kind 各归各位', () => {
    const entries = buildRunTimeline(
      task({
        steps: [{ at: 1200, tool: 'read_file', ok: true, ms: 20, summary: '读配置' }],
        errors: [{ at: 1300, message: '命令退出码 1' }],
        checkpoints: [{ at: 1400, label: '改完', note: '2 个文件' }],
      }),
    )
    expect(entries.map((entry) => entry.kind)).toEqual(['step', 'error', 'checkpoint'])
  })

  it('★ 按时间升序排好（三类混在一起也不乱）', () => {
    const entries = buildRunTimeline(
      task({
        /* 故意打乱输入顺序：检查点在前、错误在中间 */
        checkpoints: [{ at: 1100, label: '起点', note: '' }],
        steps: [
          { at: 1500, tool: 'run_shell', ok: true, ms: 5, summary: '跑测试' },
          { at: 1300, tool: 'read_file', ok: true, ms: 1, summary: '读文件' },
        ],
        errors: [{ at: 1400, message: '超时' }],
      }),
    )
    expect(entries.map((entry) => entry.at)).toEqual([1100, 1300, 1400, 1500])
  })

  it('★ 同一时刻保持原始顺序（steps → errors → checkpoints），排序稳定', () => {
    const entries = buildRunTimeline(
      task({
        steps: [
          { at: 2000, tool: 'read_file', ok: true, ms: 1, summary: 'a' },
          { at: 2000, tool: 'list_dir', ok: true, ms: 1, summary: 'b' },
        ],
        errors: [{ at: 2000, message: '同刻的错' }],
        checkpoints: [{ at: 2000, label: '同刻的检查点', note: '' }],
      }),
    )
    expect(entries.map((entry) => entry.detail)).toEqual(['a · 1ms', 'b · 1ms', '同刻的错', ''])
    /* 再跑一次，顺序一模一样 —— 不能抖 */
    const again = buildRunTimeline(
      task({
        steps: [
          { at: 2000, tool: 'read_file', ok: true, ms: 1, summary: 'a' },
          { at: 2000, tool: 'list_dir', ok: true, ms: 1, summary: 'b' },
        ],
        errors: [{ at: 2000, message: '同刻的错' }],
        checkpoints: [{ at: 2000, label: '同刻的检查点', note: '' }],
      }),
    )
    expect(again.map((entry) => entry.title)).toEqual(entries.map((entry) => entry.title))
  })
})

describe('AG-048 / 缺时间戳不炸', () => {
  it('★ 条目没有 at 也不会抛，照样进得来', () => {
    const entries = buildRunTimeline(
      task({
        steps: [{ tool: 'read_file', ok: true, ms: 0, summary: '没时间戳' } as never],
      }),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].atKnown).toBe(false)
    expect(entries[0].at).toBe(0)
    /* 内容没丢 —— 不是「静默丢掉坏条目」 */
    expect(entries[0].detail).toBe('没时间戳')
  })

  it('★ 坏时间戳（NaN / 0 / 负数 / undefined）都算「没有时间」', () => {
    const entries = buildRunTimeline(
      task({
        errors: [
          { at: Number.NaN, message: 'NaN' },
          { at: 0, message: '零' },
          { at: -5, message: '负数' },
          { message: '缺字段' } as never,
        ],
      }),
    )
    expect(entries.map((entry) => entry.atKnown)).toEqual([false, false, false, false])
  })

  it('★ 没有时间的排最后，且不破坏有时间那批的顺序', () => {
    const entries = buildRunTimeline(
      task({
        steps: [{ tool: 'list_dir', ok: true, ms: 0, summary: '没时间' } as never],
        errors: [{ at: 900, message: '有时间' }],
        checkpoints: [{ at: 800, label: '更早', note: '' }],
      }),
    )
    expect(entries.map((entry) => entry.atKnown)).toEqual([true, true, false])
    expect(entries.map((entry) => entry.at)).toEqual([800, 900, 0])
  })
})

describe('AG-048 / 空任务与字段兜底', () => {
  it('什么都没有的任务 → 空数组（界面据此说「还没有可展示的记录」）', () => {
    expect(buildRunTimeline(task())).toEqual([])
  })

  it('数组字段整体缺失也不炸（磁盘上的老记录 / 被写坏的记录）', () => {
    const broken = task()
    delete (broken as Partial<TaskRecord>).steps
    delete (broken as Partial<TaskRecord>).errors
    delete (broken as Partial<TaskRecord>).checkpoints
    expect(buildRunTimeline(broken)).toEqual([])
  })

  it('工具名转人话，认不出的返原名；摘要为空就不编内容', () => {
    const entries = buildRunTimeline(
      task({
        steps: [
          { at: 10, tool: 'run_shell', ok: true, ms: 0, summary: '' },
          { at: 20, tool: 'future_tool', ok: true, ms: 0, summary: '' },
        ],
      }),
    )
    expect(entries[0].title).toBe('运行命令')
    expect(entries[0].detail).toBe('')
    expect(entries[1].title).toBe('future_tool')
  })

  it('失败的工具 ok=false；检查点恒为 true（发生过，不是「成功」）', () => {
    const entries = buildRunTimeline(
      task({
        steps: [{ at: 10, tool: 'run_shell', ok: false, ms: 3, summary: '退出码 1' }],
        checkpoints: [{ at: 20, label: '检查点', note: '' }],
      }),
    )
    expect(entries[0].ok).toBe(false)
    expect(entries[1].ok).toBe(true)
  })

  it('老记录缺 ok 字段按成功算，不把好事报成坏事', () => {
    const entries = buildRunTimeline(
      task({ steps: [{ at: 10, tool: 'read_file', ms: 0, summary: '读' } as never] }),
    )
    expect(entries[0].ok).toBe(true)
  })

  it('错误标题取首行并截断，detail 保留完整正文', () => {
    const long = `第一行出错了\n${'x'.repeat(200)}`
    const entries = buildRunTimeline(task({ errors: [{ at: 10, message: long }] }))
    expect(entries[0].title).toBe('第一行出错了')
    expect(entries[0].detail).toBe(long)
    expect(entries[0].ok).toBe(false)
  })
})
