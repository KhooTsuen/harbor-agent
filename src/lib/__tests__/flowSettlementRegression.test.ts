import { describe, expect, it } from 'vitest'
import type { Message } from '@/types'
import type { ChatEvent } from '@/types/chat-events'
import { advanceFlow, purposeOf, type ConversationFlow } from '../conversationFlow'
import {
  answerPatch,
  existingAnswersAfter,
  questionOf,
  questionTargetOf,
  toAnswerRecord,
} from '../answers'
import { bodyTextOf } from '../bodyText'
import { fullRecordText } from '../export'
import { StoredMessageSchema } from '../schemas'

const run = (events: Record<string, unknown>[]): ConversationFlow =>
  events.reduce(advanceFlow, { version: 2, turn: 0, nodes: [] } as ConversationFlow)
const message = (flow: ConversationFlow): Message => ({
  id: 'answer',
  threadId: 'thread',
  role: 'assistant',
  content: '累计原文',
  kind: 'text',
  status: 'sent',
  timestamp: 1,
  flow,
})
const speeches = (flow: ConversationFlow) => flow.nodes.filter((node) => node.kind === 'speech')

describe('第二阶段交付回归', () => {
  it('重读后的提问始终用磁盘 key 绑定新执行，并能找回旧回答与所属提问', () => {
    const question = { ...message(run([])), role: 'user' as const, id: 'ui-new', diskKey: 'disk-q' }
    const answer = { ...message(run([])), content: '旧回答', answersKey: 'disk-q' }
    const messages = [question, answer]
    const target = questionTargetOf(messages)
    expect(target).toEqual({ key: 'disk-q', version: 0 })
    expect(existingAnswersAfter(messages, target)).toHaveLength(1)
    expect(existingAnswersAfter(messages, { key: question.id, version: 0 })).toHaveLength(1)
    expect(questionOf(messages, answer)).toBe(question)
  })

  it('纯聊天 stop 定稿后，显示、复制与完整导出仍取同一份答复', () => {
    const flow = run([
      { type: 'content', text: '唯一答案' },
      { type: 'done', finishReason: 'stop' },
    ])
    expect(bodyTextOf(message(flow))).toBe('唯一答案')
    expect(fullRecordText(message(flow)).match(/唯一答案/g)).toHaveLength(1)
  })

  it('完整记录只导出一次正式答复，同时保留有序过程', () => {
    const flow = run([
      { type: 'content', text: '先读取' },
      { type: 'agent.tool.started', toolCallId: 'read' },
      { type: 'content', text: '唯一结论' },
      { type: 'done', finalContent: '唯一结论' },
    ])
    const exported = fullRecordText(message(flow))
    expect(exported).toContain('先读取')
    expect(exported.match(/唯一结论/g)).toHaveLength(1)
    expect(exported.indexOf('</details>')).toBeLessThan(exported.indexOf('唯一结论'))
  })

  it('连续文字的答复信号变化会创建独立节点，后续工具只降级过程文字', () => {
    const explicitAnswer: ChatEvent = {
      requestId: 'req-1',
      type: 'content',
      text: '明确答复',
      stage: 'answer',
    }
    const flow = run([
      { type: 'content', text: '过程预告' },
      explicitAnswer,
      { type: 'content', text: '继续核对' },
      { type: 'agent.tool.started', toolCallId: 'verify' },
    ])
    expect(speeches(flow).map((node) => [node.text, purposeOf(node)])).toEqual([
      ['过程预告', 'chatter'],
      ['明确答复', 'answer'],
      ['继续核对', 'chatter'],
    ])
    expect(new Set(flow.nodes.map((node) => node.id)).size).toBe(flow.nodes.length)
  })

  it('工具前的明确答复随最终正文结算，不因最后一轮仅有补充而丢失', () => {
    const flow = run([
      { type: 'content', text: '明确答复', stage: 'answer' },
      { type: 'agent.tool.started', toolCallId: 'verify' },
      { type: 'turn_start' },
      { type: 'content', text: '核对补充' },
      { type: 'done', finalContent: '核对补充' },
    ])
    expect(bodyTextOf(message(flow))).toBe('明确答复\n\n核对补充')
    expect(speeches(flow).map(purposeOf)).toEqual(['final', 'final'])
  })

  it('末轮汇总已含明确答复时不会再拼接一遍', () => {
    const flow = run([
      { type: 'content', text: '明确答复', stage: 'answer' },
      { type: 'agent.tool.started', toolCallId: 'verify' },
      { type: 'done', finalContent: '明确答复\n\n核对补充' },
    ])
    expect(flow.final).toBe('明确答复\n\n核对补充')
  })

  it('暂停保留原过程用途，只把尚未结算的答复标为未确认', () => {
    const flow = run([
      { type: 'content', text: '过程' },
      { type: 'agent.tool.started', toolCallId: 'read' },
      { type: 'content', text: '半截答复', stage: 'answer' },
      { type: 'done', paused: true },
    ])
    expect(speeches(flow).map(purposeOf)).toEqual(['chatter', 'unconfirmed'])
    expect(flow.final).toBeUndefined()
  })

  it.each(['aborted', 'error'])('%s 也能标记未确认正文，保留已完成的过程', (type) => {
    const flow = run([
      { type: 'content', text: '过程' },
      { type: 'agent.tool.started', toolCallId: 'read' },
      { type: 'content', text: '半截答复' },
      { type },
    ])
    expect(speeches(flow).map(purposeOf)).toEqual(['chatter', 'unconfirmed'])
  })

  it('正式 Markdown 保留原始缩进与尾部换行', () => {
    const text = '    缩进代码\n'
    expect(run([{ type: 'done', finalContent: text }]).final).toBe(text)
  })

  it('只有思考或工具的中断记录不伪报未结算正文', () => {
    const flow = run([
      { type: 'reasoning', text: '正在分析' },
      { type: 'agent.tool.started', toolCallId: 'read' },
      { type: 'aborted' },
    ])
    expect(fullRecordText({ ...message(flow), flow })).not.toContain('这段还没结算')
  })

  it('切答复版本时，执行、任务、验收和中断信息随答复一起恢复', () => {
    const source = {
      ...message(run([{ type: 'done', finalContent: '旧版' }])),
      diskKey: 'disk-answer',
      execId: 'exec-old',
      execTaskId: 'task-old',
      verdict: 'partial' as const,
      durationMs: 1234,
      interrupted: true,
      truncated: 'length' as const,
    }
    const patch = answerPatch(toAnswerRecord(source), 0)
    expect(patch).toMatchObject({
      execId: 'exec-old',
      execTaskId: 'task-old',
      verdict: 'partial',
      durationMs: 1234,
      interrupted: true,
      truncated: 'length',
    })
    expect(
      StoredMessageSchema.parse({
        ...toAnswerRecord(source),
      }),
    ).toMatchObject({
      execId: 'exec-old',
      execTaskId: 'task-old',
      verdict: 'partial',
      durationMs: 1234,
      flow: source.flow,
    })
    expect(bodyTextOf({ ...source, ...patch })).toBe('旧版')
  })

  it('切回无验收的完整旧版本会清除上一版的失败与中断信息', () => {
    const current = {
      ...message(run([])),
      execId: 'new',
      execTaskId: 'task-new',
      verdict: 'failed' as const,
      interrupted: true,
      truncated: 'length' as const,
      regeneratedFrom: 'previous',
      durationMs: 1234,
    }
    const restored = { ...current, ...answerPatch({ role: 'assistant', content: '旧答案' }, 0) }
    expect(restored.verdict).toBeUndefined()
    expect(restored.execId).toBeUndefined()
    expect(restored.execTaskId).toBeUndefined()
    expect(restored.interrupted).toBe(false)
    expect(restored.truncated).toBeUndefined()
    expect(restored.regeneratedFrom).toBeUndefined()
    expect(restored.durationMs).toBeUndefined()
  })
})
