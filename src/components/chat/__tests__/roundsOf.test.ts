import { describe, expect, it } from 'vitest'
import { hasAnything, roundsOf } from '../message/roundsOf'
import type { Message, ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   分段：新记录用自己那份，老记录**合成一轮**

   为什么这条要有测试：老记录（磁盘上一条 `rounds` 都没有 —— 那个字段是后加的）
   以前会退回「一大块思考 → 一张带边框的工具卡片 → 正文」。
   同一份对话里新旧消息长得不一样，接缝一眼可见（用户 2026-09-30 报的就是这个）。
   ══════════════════════════════════════════════════════════════ */

const run = (id: string): ToolRunRecord => ({ id, name: 'read_file', ok: true, output: '', ms: 5 })

const msg = (patch: Partial<Message> = {}): Message => ({
  id: 'm1',
  threadId: 't1',
  role: 'assistant',
  kind: 'text',
  content: '',
  status: 'sent',
  timestamp: 1,
  ...patch,
})

describe('roundsOf', () => {
  it('自带 rounds 就原样用（新记录）', () => {
    const rounds = [{ reasoning: '想过', content: '', tools: [0] }]
    expect(roundsOf(msg({ rounds }))).toBe(rounds)
  })

  it('★ 老记录（没有 rounds）合成一轮，而不是三段堆叠', () => {
    const out = roundsOf(
      msg({ reasoning: '想过', content: '正文', toolRuns: [run('r1'), run('r2')] }),
    )
    expect(out).toHaveLength(1)
    expect(out[0].reasoning).toBe('想过')
    expect(out[0].content).toBe('正文')
    /* 工具记录本身不重复存，这里存下标 —— 和流式那条路一个口径 */
    expect(out[0].tools).toEqual([0, 1])
  })

  it('只有工具、没有文字也算有东西可画', () => {
    expect(roundsOf(msg({ toolRuns: [run('r1')] }))).toHaveLength(1)
  })

  it('什么都没写 → 空（交给「在动」的占位提示，别画个空气泡）', () => {
    expect(roundsOf(msg())).toEqual([])
    expect(roundsOf(msg({ reasoning: '   ', content: '\n' }))).toEqual([])
  })

  it('hasAnything：刚按下发送（一轮空壳）→ false；来了字/工具 → true', () => {
    expect(hasAnything([{ reasoning: '', content: '  ', tools: [] }])).toBe(false)
    expect(hasAnything([{ reasoning: '在想', content: '', tools: [] }])).toBe(true)
    expect(hasAnything([{ reasoning: '', content: '', tools: [0] }])).toBe(true)
  })
})
