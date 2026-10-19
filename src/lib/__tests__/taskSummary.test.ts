import { describe, expect, it } from 'vitest'
import { taskSummaryOf, testLabelOf } from '@/lib/taskSummary'
import type { TaskEndPayload } from '@/types/notify'

/* ══════════════════════════════════════════════════════════════
   P2 #30：任务结果摘要的判据

   验收里最要紧的三条，逐条钉死：
     · 不把未运行的检查写成通过
     · 不把取消写成完成
     · 完成 / 失败 / 停下 三种结论都要覆盖
   ══════════════════════════════════════════════════════════════ */

function payload(patch: Partial<TaskEndPayload> = {}): TaskEndPayload {
  return {
    sessionId: 'sess_1',
    kind: 'success',
    title: '后台任务完成',
    description: '「修个 bug」\n已修改 2 个文件',
    outcome: {
      taskId: 'task_1',
      files: 2,
      tests: 'none',
      testCommand: '',
      testSummary: '',
    },
    ...patch,
  }
}

describe('P2 #30 任务结果摘要判据', () => {
  it('检查没跑过 → 明说「未运行」，不能说成通过', () => {
    expect(testLabelOf('none')).toBe('检查未运行')
    expect(testLabelOf('none')).not.toContain('通过')
  })

  it('跑过但读不出结果 → 单独一档，不并进通过也不并进失败', () => {
    expect(testLabelOf('unknown')).toBe('检查跑过，但读不出结果')
    expect(testLabelOf('unknown')).not.toBe(testLabelOf('none'))
    expect(testLabelOf('unknown')).not.toBe(testLabelOf('passed'))
  })

  it('四态各说各的（passed / failed / unknown / none 互不相同）', () => {
    const labels = new Set(
      (['passed', 'failed', 'unknown', 'none'] as const).map((state) => testLabelOf(state)),
    )
    expect(labels.size).toBe(4)
  })

  it('成功 → 已完成', () => {
    const view = taskSummaryOf(payload())
    expect(view.tone).toBe('success')
    expect(view.headline).toBe('这一轮已完成')
  })

  it('失败 → 失败，不是完成', () => {
    const view = taskSummaryOf(payload({ kind: 'error' }))
    expect(view.tone).toBe('failed')
    expect(view.headline).not.toContain('完成')
  })

  it('撞预算 / 转圈停下 → 说「已停下」，不是完成', () => {
    const view = taskSummaryOf(
      payload({ kind: 'warning', description: '「跑测试」\n可以继续（换个法子）、或者停下' }),
    )
    expect(view.tone).toBe('stopped')
    expect(view.headline).toBe('这一轮已停下')
    expect(view.headline).not.toContain('完成')
  })

  it('改动文件数来自任务台账，不是模型自述', () => {
    expect(taskSummaryOf(payload()).facts).toContain('改动 2 个文件')
    expect(taskSummaryOf(payload({ outcome: { ...payload().outcome, files: 0 } })).facts).toContain(
      '没有改动文件',
    )
  })

  it('没有改动文件时不提供「查看改动」入口', () => {
    const view = taskSummaryOf(
      payload({ outcome: { ...payload().outcome, files: 0, tests: 'passed' } }),
    )
    expect(view.hasFiles).toBe(false)
    expect(view.testLabel).toBe('检查通过')
  })

  it('任务名不重复塞进事实行（内核描述里那句「…」不重复）', () => {
    const view = taskSummaryOf(payload())
    expect(view.facts.some((line) => line.startsWith('「'))).toBe(false)
  })
})
