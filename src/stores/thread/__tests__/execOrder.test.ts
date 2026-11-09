import { describe, expect, it, beforeEach } from 'vitest'
import { touchOrder, outOfOrderCount, forgetOrder } from '../execOrder'

/* ══════════════════════════════════════════════════════════════
   事件序号守卫

   ── 为什么值得单测 ────────────────────────────────────────────
   主进程给每条事件带 `seq`（见 `electron/core/chat-emit.cjs`），
   渲染层靠它判断「这一条是不是来得比上一条早」。这个判定错了有两种后果，
   都不会报错、只会让界面看起来对：
     · 太松（把回退也当成前进）→ 真乱序时没人知道，等于没加 seq
     · 太紧（把正常前进判成回退）→ 告警刷屏，报告里全是假的乱序
   所以边界（0 / 负数 / NaN / 缺字段）和「不同执行互不干扰」都要钉住。
   ══════════════════════════════════════════════════════════════ */

describe('执行顺序 / seq 守卫', () => {
  beforeEach(() => {
    /* 每个用例从干净状态开始（模块级 Map 会跨用例留着） */
    forgetOrder('req_a')
    forgetOrder('req_b')
  })

  it('★★★ 递增的序号一路 ok', () => {
    for (const seq of [1, 2, 3, 10]) {
      expect(touchOrder({ requestId: 'req_a', seq })).toBe('ok')
    }
    expect(outOfOrderCount('req_a')).toBe(0)
  })

  it('★★★ 序号回退 → out-of-order，并记一次', () => {
    expect(touchOrder({ requestId: 'req_a', seq: 5 })).toBe('ok')
    expect(touchOrder({ requestId: 'req_a', seq: 3 })).toBe('out-of-order')
    expect(outOfOrderCount('req_a')).toBe(1)
    /* 回退不更新水位：后面的 4 仍然算回退（因为水位还是 5） */
    expect(touchOrder({ requestId: 'req_a', seq: 4 })).toBe('out-of-order')
    expect(outOfOrderCount('req_a')).toBe(2)
    /* 追上来之后恢复 */
    expect(touchOrder({ requestId: 'req_a', seq: 6 })).toBe('ok')
  })

  it('★★★ 相同序号不算回退（一批正文共用一个起始序号）', () => {
    expect(touchOrder({ requestId: 'req_a', seq: 7 })).toBe('ok')
    expect(touchOrder({ requestId: 'req_a', seq: 7 })).toBe('ok')
    expect(outOfOrderCount('req_a')).toBe(0)
  })

  it('★★★ 老主进程不发 seq → no-seq，且不污染水位', () => {
    expect(touchOrder({ requestId: 'req_a', seq: 9 })).toBe('ok')
    /* 没有 seq 的事件不该把水位冲掉 */
    expect(touchOrder({ requestId: 'req_a' })).toBe('no-seq')
    expect(touchOrder({ requestId: 'req_a', seq: 10 })).toBe('ok')
    expect(outOfOrderCount('req_a')).toBe(0)
  })

  it('★★ 0 / 负数 / NaN / 非数字一律当「没有序号」', () => {
    expect(touchOrder({ requestId: 'req_a', seq: 0 })).toBe('no-seq')
    expect(touchOrder({ requestId: 'req_a', seq: -3 })).toBe('no-seq')
    expect(touchOrder({ requestId: 'req_a', seq: Number.NaN })).toBe('no-seq')
    expect(touchOrder({ requestId: 'req_a', seq: 'abc' })).toBe('no-seq')
    expect(touchOrder({ requestId: 'req_a', seq: null })).toBe('no-seq')
    expect(outOfOrderCount('req_a')).toBe(0)
  })

  it('★★★ 不同执行互不干扰（三次执行各有各的序号空间）', () => {
    expect(touchOrder({ requestId: 'req_a', seq: 20 })).toBe('ok')
    /* 另一次执行从 1 开始，不该被判成回退 */
    expect(touchOrder({ requestId: 'req_b', seq: 1 })).toBe('ok')
    expect(touchOrder({ requestId: 'req_b', seq: 2 })).toBe('ok')
    expect(outOfOrderCount('req_a')).toBe(0)
    expect(outOfOrderCount('req_b')).toBe(0)
  })

  it('★★ 没有 requestId 的事件不建档', () => {
    expect(touchOrder({ seq: 3 })).toBe('no-seq')
    expect(outOfOrderCount('')).toBe(0)
  })

  it('★★ forgetOrder 之后重新开始（新一轮从 1 起不算回退）', () => {
    expect(touchOrder({ requestId: 'req_a', seq: 50 })).toBe('ok')
    forgetOrder('req_a')
    expect(outOfOrderCount('req_a')).toBe(0)
    expect(touchOrder({ requestId: 'req_a', seq: 1 })).toBe('ok')
  })
})
