import { describe, expect, it } from 'vitest'
import { StoredMessageSchema, SessionLineSchema, safeParse } from '@/lib/schemas'

describe('schemas 运行时校验', () => {
  it('合法消息通过', () => {
    const parsed = safeParse(StoredMessageSchema, {
      role: 'assistant',
      content: 'hello',
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.role).toBe('assistant')
  })

  it('content 缺省时给空串', () => {
    const parsed = safeParse(StoredMessageSchema, { role: 'user' })
    expect(parsed?.content).toBe('')
  })

  it('新对话流的落盘字段通过 schema 并保留到读回形状', () => {
    const value = {
      role: 'assistant',
      content: '正式答复',
      aborted: true,
      truncated: 'length',
      durationMs: 120,
      regeneratedFrom: 'old-answer',
      verdict: 'partial',
      execId: 'exec-1',
      execTaskId: 'task-1',
      flow: { version: 2, turn: 1, nodes: [], final: '正式答复' },
      versions: ['旧版', '新版'],
      versionIndex: 1,
      answersKey: 'question-1',
      answersVersion: 1,
      parentKey: 'parent-question',
      parentVersion: 1,
      answerIndex: 0,
      answerIndexByVersion: { '1': 0 },
      answerRecords: [{ content: '旧答复' }],
    }
    expect(safeParse(StoredMessageSchema, value)).toEqual(value)
  })

  it('非法 role 被拒绝', () => {
    const parsed = safeParse(StoredMessageSchema, { role: 'hacker', content: 'x' })
    expect(parsed).toBeNull()
  })

  it('会话行按 type 区分', () => {
    const meta = safeParse(SessionLineSchema, {
      type: 'meta',
      id: 's1',
      title: 't',
      mode: 'pair',
      model: 'm',
      createdAt: 0,
    })
    expect(meta).not.toBeNull()

    const msg = safeParse(SessionLineSchema, { type: 'message', role: 'user', content: 'hi' })
    expect(msg).not.toBeNull()
  })

  it('未知 type 被拒绝', () => {
    const parsed = safeParse(SessionLineSchema, { type: 'weird' })
    expect(parsed).toBeNull()
  })
})
