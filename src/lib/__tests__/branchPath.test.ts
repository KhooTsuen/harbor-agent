import { describe, expect, it } from 'vitest'
import { getForkPoints, previewOf } from '../branchPath'
import type { Message } from '@/types'

/* ══════════════════════════════════════════════════════════════
   分支路径：分叉点怎么算（纯函数）

   覆盖验收 a / e 的数据面：层号（L1、L2）、当前/总数、兄弟选项、
   「只算真分叉」「只数这一版的回答」两条口径。
   ══════════════════════════════════════════════════════════════ */

const msg = (over: Partial<Message>): Message => ({
  id: 'm',
  threadId: 't1',
  role: 'assistant',
  content: '',
  kind: 'text',
  status: 'sent',
  timestamp: 1,
  ...over,
})

const rec = (key: string, content: string, version: number) => ({
  role: 'assistant' as const,
  key,
  content,
  answersVersion: version,
  ts: 1,
})

/** 三层分叉：提问改版（L1）→ 回答有几条（L2）→ 后面的提问又改版（L3） */
function multiFork(): Message[] {
  return [
    msg({
      id: 'q1',
      role: 'user',
      content: 'B 内容（第二版）',
      versions: ['A 内容（第一版）', 'B 内容（第二版）'],
      versionIndex: 1,
      timestamp: 1,
    }),
    msg({
      id: 'a1',
      content: 'B 的第二条回答',
      answersKey: 'q1',
      answersVersion: 1,
      answerIndex: 1,
      answerRecords: [rec('r1', 'B 的第一条回答', 1)],
      timestamp: 2,
    }),
    msg({
      id: 'q2',
      role: 'user',
      content: '第三版提问',
      versions: ['一版', '二版', '三版'],
      versionIndex: 2,
      timestamp: 3,
    }),
    msg({ id: 'a2', content: '唯一的回答', answersKey: 'q2', answersVersion: 2, timestamp: 4 }),
  ]
}

describe('getForkPoints（验收 a / e）', () => {
  it('a · 沿路径列出全部分叉点：层号、名称、当前/总数、兄弟选项', () => {
    const forks = getForkPoints(multiFork())
    expect(forks.map((f) => f.level)).toEqual([1, 2, 3])
    expect(forks.map((f) => f.kind)).toEqual(['question', 'answer', 'question'])
    expect(forks.map((f) => f.name)).toEqual(['提问 1', '答复 1', '提问 2'])

    const [q1, a1, q2] = forks
    expect(q1!.current).toBe(1)
    expect(q1!.total).toBe(2)
    expect(q1!.options.map((o) => o.preview)).toEqual(['A 内容（第一版）', 'B 内容（第二版）'])
    expect(q1!.options.map((o) => o.current)).toEqual([false, true])
    expect(q1!.options.map((o) => o.label)).toEqual(['第 1 版', '第 2 版'])

    expect(a1!.current).toBe(1)
    expect(a1!.total).toBe(2)
    expect(a1!.options.map((o) => o.preview)).toEqual(['B 的第一条回答', 'B 的第二条回答'])

    expect(q2!.current).toBe(2)
    expect(q2!.total).toBe(3)
  })

  it('只算真分叉：没改过、没重新生成过的消息不进路径', () => {
    const plain = [
      msg({ id: 'q', role: 'user', content: '一个问题', timestamp: 1 }),
      msg({ id: 'a', content: '一个回答', timestamp: 2 }),
    ]
    expect(getForkPoints(plain)).toEqual([])
  })

  it('★ 别的版本的回答不算这一层的兄弟（不产生分叉）', () => {
    const other = [
      msg({ id: 'q', role: 'user', content: 'x', timestamp: 1 }),
      msg({
        id: 'a',
        content: '答当前版',
        answersKey: 'q',
        answersVersion: 1,
        answerRecords: [rec('o1', '旧版回答', 0), rec('o2', '旧版回答 2', 0)],
        timestamp: 2,
      }),
    ]
    expect(getForkPoints(other)).toEqual([])
  })

  it('越界的版本号夹回范围（脏数据不炸）', () => {
    const bad = [
      msg({
        id: 'q',
        role: 'user',
        content: 'x',
        versions: ['一', '二'],
        versionIndex: 9,
        timestamp: 1,
      }),
    ]
    const forks = getForkPoints(bad)
    expect(forks[0]?.current).toBe(1)
  })
})

describe('previewOf', () => {
  it('取第一行并截断', () => {
    expect(previewOf('第一行\n第二行')).toBe('第一行')
    expect(previewOf('x'.repeat(40))).toBe(`${'x'.repeat(28)}…`)
    expect(previewOf('')).toBe('（空）')
  })
})
