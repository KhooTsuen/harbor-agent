import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   裁剪说明要说人话（2026-10-04，小尾巴 #6）

   以前预算被挤到极限时，一条旧消息会被裁得**只剩 14 字符的说明**
   （`[…上下文已按预算裁剪…]`）——它占着预算却不提供任何信息。
   现在：
     · 裁剪说明带上**原长**（能区分「本来就短」和「两万字只进来开头」）；
     · 这种残片干脆不保留（整条不进上下文），并用**一行**告诉模型少了多少条；
     · 尾部 `…上下文已按预算裁剪…` 保持原措辞（历史文档/自检组认这个串）。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..', '..')
const require_ = createRequire(import.meta.url)
const ctx = require_(join(ROOT, 'electron/core/context-builder.cjs')) as {
  assemble: (input: Record<string, unknown>) => {
    messages: { role: string; content: string }[]
    systemContext: { conversationState: string }
    estimates: { selectedMessages: number; droppedMessages: number }
  }
  trim: (value: string, limit: number) => string
  MIN_KEEP_CHARS: number
}

describe('上下文裁剪说明', () => {
  it('★ 被裁的消息：说明里带原长，并保留老措辞（向后兼容）', () => {
    const text = 'x'.repeat(5000)
    const out = ctx.trim(text, 1000)
    expect(out).toContain('原有 5000 字符')
    expect(out).toContain('…上下文已按预算裁剪…')
    expect(out.length).toBeLessThanOrEqual(1000)
    expect(out.startsWith('x')).toBe(true)
  })

  it('没超就不动（不许多加任何字符）', () => {
    expect(ctx.trim('你好', 100)).toBe('你好')
  })

  it('★ 预算被挤到极限时不产生「只剩一行说明」的残片', () => {
    /* 对话额度只有 400（下限）：两条 5000 字符的消息，第二条放不下像样的开头 */
    const messages = [
      { role: 'user', content: 'a'.repeat(5000) },
      { role: 'assistant', content: 'b'.repeat(20) },
      { role: 'user', content: 'c'.repeat(30) },
    ]
    const out = ctx.assemble({ maxTokens: 2000, budget: { conversation: 3 }, messages })
    /* 最近的短消息照旧进来 */
    expect(out.messages.length).toBeGreaterThan(0)
    /* 关键：**没有任何一条**是「只剩一行说明」的残片 */
    for (const m of out.messages) {
      const text = String(m.content)
      if (text.includes('上下文已按预算裁剪')) {
        expect(text.split('上下文已按预算裁剪')[0].length).toBeGreaterThan(ctx.MIN_KEEP_CHARS - 1)
      }
    }
  })

  it('★ 有消息被整条丢掉时，会话状态里有一行说明（只说一次，不是每条一行）', () => {
    const messages = [
      { role: 'user', content: 'a'.repeat(5000) },
      { role: 'user', content: 'b'.repeat(5000) },
      { role: 'user', content: 'c'.repeat(5000) },
    ]
    const out = ctx.assemble({ maxTokens: 2000, budget: { conversation: 3 }, messages })
    expect(out.estimates.droppedMessages).toBeGreaterThan(0)
    expect(out.systemContext.conversationState).toContain('因预算没进上下文')
    /* 说明只出现一次 */
    expect(out.systemContext.conversationState.split('因预算没进上下文').length - 1).toBe(1)
  })

  it('没有丢消息时不加那行（别给模型塞无用信息）', () => {
    const out = ctx.assemble({
      maxTokens: 2000,
      messages: [{ role: 'user', content: '你好' }],
    })
    expect(out.estimates.droppedMessages).toBe(0)
    expect(out.systemContext.conversationState).not.toContain('因预算没进上下文')
  })

  it('本来就很短的消息不会被当残片丢掉（「你好」必须还在）', () => {
    const out = ctx.assemble({
      maxTokens: 2000,
      budget: { conversation: 3 },
      messages: [
        { role: 'user', content: '很长很长'.repeat(1000) },
        { role: 'user', content: '你好' },
      ],
    })
    expect(out.messages.map((m) => String(m.content))).toContain('你好')
  })
})
