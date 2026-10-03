import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTEXT_BASE_TOKENS } from '@/constants'
import { adviseCompact } from '../compact'

/* ══════════════════════════════════════════════════════════════
   「不限」时的上下文基准：内核与渲染层必须是同一个数

   来由（2026-10-04 真机实测）：`assistant.maxTokens = 0` 时，内核退回 4096 →
   总字符 12288 → 对话层 30% = 3686 字符。用户贴 96122 字符，模型只看到前 3646 字符
   （≈3.8%）。同一时期渲染层的压缩提示线也写死 4096，于是「预算」这件事在两个进程里
   各写了一份 —— 改一边忘一边，症状是「贴长文后每轮都被自动压缩」或者「预算改了没生效」。

   这一组钉两件事：
     ① 两边的常量**字面值相同**（跨进程没法共享常量，只能靠测试盯）；
     ② 推导算术成立：0 → 16384 → 总字符 49152 → 对话层 30% = 14745 字符（≈1.5 万）。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..', '..')
const builderSrc = readFileSync(join(ROOT, 'electron/core/context-builder.cjs'), 'utf8')

/** 从内核源码里抠出那个数字（比 require 更能挡住「改了名字/搬走了」） */
function kernelBaseTokens(): number {
  const m = /const DEFAULT_CONTEXT_TOKENS = (\d+)/.exec(builderSrc)
  if (!m) throw new Error('context-builder.cjs 里找不到 DEFAULT_CONTEXT_TOKENS')
  return Number(m[1])
}

describe('上下文基准 / 两边同一个数', () => {
  it('★ 渲染层 CONTEXT_BASE_TOKENS === 内核 DEFAULT_CONTEXT_TOKENS', () => {
    expect(CONTEXT_BASE_TOKENS).toBe(kernelBaseTokens())
  })

  it('它是「1.5 万字符量级」的基准：对话层 30% 落在 1–2 万之间', () => {
    const conversation = Math.floor((CONTEXT_BASE_TOKENS * 3 * 30) / 100)
    expect(conversation).toBe(14745)
    expect(conversation).toBeGreaterThanOrEqual(10000)
    expect(conversation).toBeLessThanOrEqual(20000)
  })

  it('仍然是有限值（防呆上限没被拿掉）', () => {
    expect(Number.isFinite(CONTEXT_BASE_TOKENS)).toBe(true)
    expect(CONTEXT_BASE_TOKENS).toBeLessThan(100000)
  })
})

describe('上下文基准 / 内核真的按这个数裁', () => {
  const require_ = createRequire(import.meta.url)
  const builder = require_(join(ROOT, 'electron/core/context-builder.cjs')) as {
    assemble: (input: Record<string, unknown>) => { messages: { content: string }[] }
    DEFAULT_CONTEXT_TOKENS: number
  }

  it('★ maxTokens=0 → 一条 2 万字符的消息能被送到 ≈14745 字符（不是 3686）', () => {
    const text = 'z'.repeat(20000)
    const out = builder.assemble({
      maxTokens: 0,
      messages: [{ role: 'user', content: text }],
    })
    const sent = String(out.messages[0]?.content ?? '')
    /* 裁剪后的长度 = 额度 − 40 + 裁剪标记（〔…上下文已按预算裁剪…〕）的长度 —— 所以断区间而不是相等 */
    expect(sent.length).toBeGreaterThan(14000)
    expect(sent.length).toBeLessThanOrEqual(14745)
    expect(sent.endsWith('上下文已按预算裁剪…]')).toBe(true)
  })

  it('显式填的小值照旧生效（用户/测试能构造小预算，没被基准顶掉）', () => {
    const out = builder.assemble({
      maxTokens: 2000,
      messages: [{ role: 'user', content: 'y'.repeat(5000) }],
    })
    const sent = String(out.messages[0]?.content ?? '')
    expect(sent.length).toBeGreaterThan(1700)
    expect(sent.length).toBeLessThanOrEqual(1800)
  })

  it('短消息一个字节都不动', () => {
    const out = builder.assemble({ maxTokens: 0, messages: [{ role: 'user', content: '你好' }] })
    expect(out.messages[0]?.content).toBe('你好')
  })
})

describe('上下文基准 / 渲染层压缩提示线跟着走', () => {
  it('★ 一万五千字符的粘贴不再被判「该自动压缩」', () => {
    const messages = [
      {
        id: 'm1',
        threadId: 't',
        role: 'user' as const,
        content: 'a'.repeat(15000),
        kind: 'text' as const,
        status: 'sent' as const,
        timestamp: 1,
      },
    ]
    const advice = adviseCompact(messages, 0)
    expect(advice.limit).toBe(CONTEXT_BASE_TOKENS)
    expect(advice.auto).toBe(false)
  })

  it('短消息既不提示也不压（老行为不变）', () => {
    const messages = [
      {
        id: 'm1',
        threadId: 't',
        role: 'user' as const,
        content: '你好',
        kind: 'text' as const,
        status: 'sent' as const,
        timestamp: 1,
      },
    ]
    const advice = adviseCompact(messages, 0)
    expect(advice.warn).toBe(false)
    expect(advice.auto).toBe(false)
  })
})
