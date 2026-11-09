import { describe, expect, it } from 'vitest'
import type { Message } from '@/types'
import { bodyTextOf } from '@/lib/bodyText'
import { threadToMarkdown } from '@/lib/export'
import type { ConversationFlow } from '@/lib/conversationFlow'

/* ══════════════════════════════════════════════════════════════
   第二阶段：显示 / 复制 / 导出**同一条答复**

   `bodyTextOf` 是三处的唯一口径（第一阶段收拢的）。这一组钉的是
   **flow 这条路**也走它 —— 以前 `bodyTextOf` 只看 rounds，flow.final
   根本没进视野，于是新记录复制出去是 `content`（最后一轮），不是结算后的答复。
   ══════════════════════════════════════════════════════════════ */

function msgWithFlow(flow: ConversationFlow): Message {
  return {
    id: 'msg_1',
    threadId: 't1',
    role: 'assistant',
    content: '最后一轮的原始文本',
    flow,
    timestamp: 1,
  } as Message
}

const settleFlow: ConversationFlow = {
  version: 2,
  turn: 2,
  nodes: [
    { kind: 'speech', id: 0, turn: 0, text: '我先看看这两个文件。', purpose: 'chatter' },
    { kind: 'tool', id: 1, turn: 0, toolId: 'call_1' },
    { kind: 'speech', id: 2, turn: 1, text: '结论：都没问题。', purpose: 'final' },
  ],
  final: '结论：都没问题。',
}

describe('三处同源 / flow 路径', () => {
  it('★★★ 复制（bodyTextOf）取的是 flow.final，不是 content', () => {
    const m = msgWithFlow(settleFlow)
    expect(m.content).toBe('最后一轮的原始文本')
    expect(bodyTextOf(m)).toBe('结论：都没问题。')
  })

  it('★★★ 导出正文段与复制一字不差', () => {
    const m = msgWithFlow(settleFlow)
    const md = threadToMarkdown({
      id: 't1',
      title: 'T',
      mode: 'pair',
      model: 'm',
      createdAt: 1,
      tags: [],
      messages: [m],
    } as never)
    expect(md).toContain(bodyTextOf(m))
    /* 过程话不该混进导出的正文段（它在 <details> 里，属于过程区） */
    expect(md.split('结论：都没问题。').length - 1).toBeGreaterThanOrEqual(1)
  })

  it('★★★ 没结算的 flow：正文取片段，不冒充正式答复', () => {
    const pending: ConversationFlow = {
      version: 2,
      turn: 0,
      nodes: [{ kind: 'speech', id: 0, turn: 0, text: '读到一半', purpose: 'unconfirmed' }],
    }
    const m = msgWithFlow(pending)
    /* flow.final 不存在 → bodyTextOf 走 flow 分支返回空串（不拿 content 顶替） */
    expect(bodyTextOf(m)).toBe('')
  })

  it('★★ 只有 chatter 的 flow：正文为空（过程话不算答复）', () => {
    const onlyChatter: ConversationFlow = {
      version: 2,
      turn: 0,
      nodes: [{ kind: 'speech', id: 0, turn: 0, text: '我先看看', purpose: 'chatter' }],
    }
    expect(bodyTextOf(msgWithFlow(onlyChatter))).toBe('')
  })
})
