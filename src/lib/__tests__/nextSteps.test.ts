import { describe, expect, it } from 'vitest'
import { nextStepsFor } from '../nextSteps'
import type { TaskOutcome } from '@/types/notify'

/* ══════════════════════════════════════════════════════════════
   下一步 —— 上下文相关（AG-033 给入口 · AG-034 按上下文挑）

   文档两个例子：
     「修改完成，测试尚未运行。」 → [运行测试]
     「任务已完成。」            → [查看 Diff][查看测试结果][继续优化]

   外加 AG-033 那条硬规矩：**只能作为快捷入口，不得未经许可自动执行
   高风险操作** —— 所以凡是带 prompt 的，文案里不许出现命令。
   ══════════════════════════════════════════════════════════════ */

const outcome = (patch: Partial<TaskOutcome> = {}): TaskOutcome => ({
  taskId: 'task_1',
  files: 0,
  tests: 'none',
  testCommand: '',
  testSummary: '',
  ...patch,
})

const labels = (patch: Partial<TaskOutcome> = {}) =>
  nextStepsFor(outcome(patch)).steps.map((step) => step.label)

describe('AG-034 / 头一句说清这次干成了什么', () => {
  it('改了文件、没跑测试 → 「修改完成，测试尚未运行。」', () => {
    expect(nextStepsFor(outcome({ files: 3 })).headline).toBe('修改完成，测试尚未运行。')
  })

  it('改了文件、测试通过 → 「修改完成，测试通过。」', () => {
    expect(nextStepsFor(outcome({ files: 3, tests: 'passed' })).headline).toBe(
      '修改完成，测试通过。',
    )
  })

  it('测试没过 → 「测试没有通过。」（不管改没改文件）', () => {
    expect(nextStepsFor(outcome({ files: 3, tests: 'failed' })).headline).toBe('测试没有通过。')
    expect(nextStepsFor(outcome({ tests: 'failed' })).headline).toBe('测试没有通过。')
  })

  it('没改文件、也没跑测试 → 「检查完成，没有改动文件。」', () => {
    expect(nextStepsFor(outcome()).headline).toBe('检查完成，没有改动文件。')
  })

  it('★ 老记录读不出退出码时不冒充结果', () => {
    expect(nextStepsFor(outcome({ tests: 'unknown' })).headline).toContain('没读出来')
  })
})

describe('AG-034 / 入口随上下文变', () => {
  it('改了文件 + 没跑测试 → 首推「运行测试」', () => {
    expect(labels({ files: 2 })).toEqual(['运行测试', '查看 Diff', '提交修改', '继续优化'])
  })

  it('★ 测试跑过了就不再劝「运行测试」，改给「查看测试结果」', () => {
    const passed = labels({ files: 2, tests: 'passed' })
    expect(passed).not.toContain('运行测试')
    expect(passed).toContain('查看测试结果')
  })

  it('★ 测试没过 → 不给「提交修改」，先让定位原因', () => {
    const failed = labels({ files: 2, tests: 'failed' })
    expect(failed).toContain('定位失败原因')
    expect(failed).not.toContain('提交修改')
    expect(failed).not.toContain('继续优化')
  })

  it('没改文件、测试通过 → 只给「查看测试结果 + 继续检查」', () => {
    expect(labels({ tests: 'passed' })).toEqual(['查看测试结果', '继续检查'])
  })

  it('没改文件、没跑测试 → 只给「继续检查」', () => {
    expect(labels()).toEqual(['继续检查'])
  })

  it('最多四个入口（别再堆成一排）', () => {
    for (const patch of [
      { files: 9 },
      { files: 9, tests: 'passed' as const },
      { files: 9, tests: 'failed' as const },
    ]) {
      expect(labels(patch).length, JSON.stringify(patch)).toBeLessThanOrEqual(4)
    }
  })
})

describe('AG-033 / 「只能作为快捷入口」这条界线还在', () => {
  it('★ 查看 Diff / 查看测试结果都不带要发的话（纯看）', () => {
    for (const step of nextStepsFor(outcome({ files: 1, tests: 'passed' })).steps) {
      if (step.id === 'diff' || step.id === 'testResult') {
        expect(step.prompt, step.label).toBeUndefined()
      }
    }
  })

  it('★ 提交修改要先给人看 —— 不允许「直接提交」', () => {
    const commit = nextStepsFor(outcome({ files: 1 })).steps.find((step) => step.id === 'commit')
    expect(commit?.prompt).toContain('我确认之后再提交')
    expect(commit?.prompt).not.toMatch(/^提交$|直接提交/)
  })

  it('★ 其余入口都只是把话写好，不含任何命令', () => {
    for (const patch of [
      { files: 2 },
      { files: 2, tests: 'passed' as const },
      { files: 2, tests: 'failed' as const },
      {},
    ]) {
      for (const step of nextStepsFor(outcome(patch)).steps) {
        if (!step.prompt) continue
        expect(step.prompt, step.label).not.toMatch(/[`$]|rm -|sudo|curl|&&|\|\|/)
      }
    }
  })
})
