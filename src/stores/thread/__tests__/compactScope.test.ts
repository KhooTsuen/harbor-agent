import { describe, expect, it } from 'vitest'
import type { Message } from '@/types'
import { CONTEXT_BASE_TOKENS } from '@/constants'
import {
  adviseCompact,
  contextMessages,
  estimateMessages,
  modelWindowOf,
  resolveLimit,
  usableOf,
} from '../compact'

/* ══════════════════════════════════════════════════════════════
   压缩的两条口径（真机反馈 12）

   12b：用量只算**压缩点之后**那一段 —— 否则压过一次之后永远超线，
        每一轮都自动压一次，摘要互相覆盖、越压越糊。
   12a：分母 = `min(模型窗口 × 0.8, 用户上限)`，未知模型退回 baseTokens。
   ══════════════════════════════════════════════════════════════ */

const msg = (
  content: string,
  role: Message['role'] = 'user',
  extra: Partial<Message> = {},
): Message => ({
  id: `m-${role}-${content.slice(0, 8)}`,
  threadId: 't1',
  role,
  content,
  kind: 'text',
  status: 'sent',
  timestamp: 1,
  ...extra,
})

const LONG = 'x'.repeat(3000)
const thirtyLong = Array.from({ length: 30 }, (_, i) => msg(`${LONG} #${i}`))

describe('12b：用量只算压缩点之后那一段', () => {
  it('★ 压过一次之后不再永远超线（这正是「每轮都压」的根因）', () => {
    const marker = msg('已压缩前 30 条', 'system', { compactUpTo: 30 })
    const all = [...thirtyLong, marker, msg('刚说的话')]

    /* 压之前：妥妥超自动线 */
    const before = adviseCompact(thirtyLong, 16384).used
    expect(before / 16384).toBeGreaterThan(0.6)

    /* 压之后：只剩最后那一句的量，不该再触发自动压 */
    const after = adviseCompact(all, 16384)
    expect(after.used).toBeLessThan(before / 10)
    expect(after.auto).toBe(false)
    expect(after.warn).toBe(false)
  })

  it('没压过 → 全部可用消息都算', () => {
    const list = [msg('一'), msg('二', 'assistant')]
    expect(contextMessages(list)).toHaveLength(2)
    expect(estimateMessages(contextMessages(list))).toBe(estimateMessages(usableOf(list)))
  })

  it('可用消息的定义与内核一致：system 不算；只有图片、没文字的算', () => {
    const list = [
      msg('有文字'),
      msg('系统消息', 'system'),
      msg('', 'user', { images: ['data:image/png;base64,AAA'] }),
      msg('   ', 'assistant'),
    ]
    expect(usableOf(list)).toHaveLength(2)
  })

  it('upTo 比可用条数还大时不越界（就当全被摘要覆盖了）', () => {
    const list = [msg('一'), msg('压缩点', 'system', { compactUpTo: 99 })]
    expect(contextMessages(list)).toHaveLength(0)
  })

  it('取的是**最后一个**压缩点', () => {
    const list = [
      msg('一'),
      msg('二'),
      msg('压缩点 1', 'system', { compactUpTo: 1 }),
      msg('三'),
      msg('压缩点 2', 'system', { compactUpTo: 3 }),
      msg('四'),
    ]
    expect(contextMessages(list).map((m) => m.content)).toEqual(['四'])
  })
})

describe('12a：分母 = min(模型窗口 × 0.8, 用户上限)', () => {
  it('窗口比上限大 → 用用户上限（不能因为知道窗口就绕过人家的刹车）', () => {
    expect(resolveLimit(40_000, 128_000)).toBe(40_000)
  })

  it('窗口比上限小 → 用窗口的 80%（留 20% 给模型写答案）', () => {
    expect(resolveLimit(200_000, 32_000)).toBe(25_600)
  })

  it('窗口未知 → 退回用户上限；连上限都没有 → 退回内核基准', () => {
    expect(resolveLimit(50_000, null)).toBe(50_000)
    expect(resolveLimit(0, null)).toBe(CONTEXT_BASE_TOKENS)
  })

  it('下限 2000 兜着（别把分母算成 800）', () => {
    expect(resolveLimit(0, 1000)).toBe(2000)
  })

  it('模型窗口从能力矩阵取；查不到是 null（未知 ≠ 很小）', () => {
    const matrix = {
      models: { 'deepseek-v4': { caps: { context_window: 128_000 } } },
    } as never
    expect(modelWindowOf(matrix, 'deepseek-v4')).toBe(128_000)
    expect(modelWindowOf(matrix, '没听说过的模型')).toBeNull()
    expect(modelWindowOf(undefined, 'deepseek-v4')).toBeNull()
  })
})
