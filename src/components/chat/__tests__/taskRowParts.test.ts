import { describe, expect, it } from 'vitest'
import { rowStatusSummary, rowStepPrefix } from '../TaskRowParts'

/* ══════════════════════════════════════════════════════════════
   任务行收起时的两行摘要（从 TaskRow 抽出来的纯函数）

   为什么值得单测：这两行是「一眼看过去就懂」的关键 ——
   状态 + **为什么停下**（撞预算 / 转圈）要说清楚，不然用户只看到一个「已暂停」，
   还得点开详情才知道发生了什么。
   ══════════════════════════════════════════════════════════════ */

describe('任务行 / 状态摘要', () => {
  it('普通状态只说状态', () => {
    expect(rowStatusSummary('completed')).toBe('已完成')
    expect(rowStatusSummary('running')).toBe('进行中')
  })

  it('★ 撞预算：把「为什么停」说出来', () => {
    expect(rowStatusSummary('paused', { budgetLabel: '轮数上限' })).toBe('已暂停 · 达到轮数上限')
  })

  it('★ 转圈停下：也说出来', () => {
    expect(rowStatusSummary('paused', { loop: true })).toBe('已暂停 · 检测到重复执行')
  })

  it('两个都命中时先说预算（那是先发生的）', () => {
    expect(rowStatusSummary('paused', { budgetLabel: '轮数上限', loop: true })).toBe(
      '已暂停 · 达到轮数上限',
    )
  })

  it('没命中时不受影响', () => {
    expect(rowStatusSummary('paused', {})).toBe('已暂停')
    expect(rowStatusSummary('paused', { budgetLabel: undefined, loop: false })).toBe('已暂停')
  })
})

describe('任务行 / 步骤前缀', () => {
  it('停下来等你的 → 下一步', () => {
    expect(rowStepPrefix('paused')).toBe('下一步：')
    expect(rowStepPrefix('waiting_user')).toBe('下一步：')
  })

  it('在跑的 → 正在做', () => {
    expect(rowStepPrefix('running')).toBe('正在做：')
  })

  it('收尾的状态前后缀不给（别硬凑一句话）', () => {
    expect(rowStepPrefix('completed')).toBe('')
    expect(rowStepPrefix('cancelled')).toBe('')
    expect(rowStepPrefix('failed')).toBe('')
  })
})
