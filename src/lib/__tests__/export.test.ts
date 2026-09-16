import { describe, expect, it } from 'vitest'
import { threadToMarkdown } from '@/lib/export'
import type { Thread } from '@/types'

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    projectId: 'p1',
    title: '测试线程',
    messages: [],
    status: 'idle',
    mode: 'pair',
    model: 'test',
    reasoning: 'high',
    pinned: false,
    archived: false,
    tags: [],
    exportedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('threadToMarkdown', () => {
  it('空线程也有标题和元信息', () => {
    const md = threadToMarkdown(makeThread())
    expect(md).toContain('# 测试线程')
    expect(md).toContain('- 模式：pair')
    expect(md).toContain('- 消息数：0')
  })

  it('带标签时列出标签', () => {
    const md = threadToMarkdown(makeThread({ tags: ['bug', 'feature'] }))
    expect(md).toContain('bug, feature')
  })

  it('用户和助手消息分别标注', () => {
    const md = threadToMarkdown(
      makeThread({
        messages: [
          {
            id: 'm1',
            threadId: 't1',
            role: 'user',
            content: '帮我看看',
            kind: 'text',
            status: 'sent',
            timestamp: 0,
          },
          {
            id: 'm2',
            threadId: 't1',
            role: 'assistant',
            content: '好的',
            kind: 'text',
            status: 'sent',
            timestamp: 0,
          },
        ],
      }),
    )
    expect(md).toContain('### 你')
    expect(md).toContain('### Agent')
    expect(md).toContain('帮我看看')
    expect(md).toContain('好的')
  })

  it('代码块用围栏包裹', () => {
    const md = threadToMarkdown(
      makeThread({
        messages: [
          {
            id: 'm1',
            threadId: 't1',
            role: 'assistant',
            content: '这是代码',
            kind: 'code',
            status: 'sent',
            timestamp: 0,
            codeBlocks: [{ id: 'c1', language: 'ts', code: 'const a = 1' }],
          },
        ],
      }),
    )
    expect(md).toContain('```ts')
    expect(md).toContain('const a = 1')
  })
})
