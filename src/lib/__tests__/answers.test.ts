import { describe, expect, it } from 'vitest'
import {
  answersOfVersion,
  answerPatch,
  existingAnswersAfter,
  questionTargetOf,
  toAnswerRecord,
} from '@/lib/answers'
import type { Message } from '@/types'
import type { StoredMessage } from '@/types/models-extra'

/* ══════════════════════════════════════════════════════════════
   「回答属于哪一版提问」的纯函数

   为什么要有：提问有多版本，但回答以前没有「我答的是哪一版」的标记 →
   切版本只能重新生成，生成品又追加在文件末尾没人认领 → 会话里并排堆着
   好几个回答（用户报的 bug，他真实会话里是 3 个）。

   这里钉住三件事：
     ① 这轮该标成「答谁、第几版」
     ② 重新生成前，旧回答要收着（不然内存里就丢了，得等重开会话）
     ③ 切到某一版 / 某一条时，取出来的是不是对的那条
   ══════════════════════════════════════════════════════════════ */

const user = (over: Partial<Message> = {}): Message => ({
  id: 'u1',
  threadId: 't1',
  role: 'user',
  content: '初始问题',
  kind: 'text',
  status: 'sent',
  timestamp: 1,
  ...over,
})

const assistant = (over: Partial<Message> = {}): Message => ({
  ...user({ role: 'assistant', content: '初始回答' }),
  ...over,
})

const record = (content: string, answersVersion = 0): StoredMessage => ({
  role: 'assistant',
  key: 'a' + content,
  content,
  answersVersion,
})

describe('questionTargetOf', () => {
  it('★ 取最后一条用户消息（发送 / 编辑重跑 / 重新生成 / 继续任务四条路共用）', () => {
    const target = questionTargetOf([
      user({ id: 'u1' }),
      assistant(),
      user({ id: 'u2', versions: ['旧', '新'], versionIndex: 1 }),
    ])
    expect(target).toEqual({ key: 'u2', version: 1 })
  })

  it('没有用户消息时返回 null（调用方据此不带这两个字段）', () => {
    expect(questionTargetOf([assistant()])).toBeNull()
  })

  it('最后一条是助手时，仍然指向它上面那条提问（重新生成走的就是这条）', () => {
    expect(questionTargetOf([user({ id: 'u1' }), assistant()])).toEqual({ key: 'u1', version: 0 })
  })
})

describe('existingAnswersAfter', () => {
  it('★ 重新生成前先把旧回答收着 —— 内存里不能丢（丢了要等重开会话才切得回去）', () => {
    const seed = existingAnswersAfter([user({ id: 'u1' }), assistant({ content: '旧回答' })], {
      key: 'u1',
      version: 0,
    })
    expect(seed.map((r) => r.content)).toEqual(['旧回答'])
  })

  it('已经有 answerRecords 时用它（重开会话后内核分好组的那份）', () => {
    const records = [record('一'), record('二')]
    const seed = existingAnswersAfter([user({ id: 'u1' }), assistant({ answerRecords: records })], {
      key: 'u1',
      version: 0,
    })
    expect(seed.length).toBe(2)
  })

  it('普通新一轮没有旧回答 → 空数组（不然会把上一轮的回答挂在这次上）', () => {
    expect(
      existingAnswersAfter([assistant({ content: '上一轮' }), user({ id: 'u2' })], {
        key: 'u2',
        version: 0,
      }),
    ).toEqual([])
  })

  it('★ 只收这条提问和它回答之间的那些，遇到下一条提问就停', () => {
    const seed = existingAnswersAfter(
      [user({ id: 'u1' }), assistant({ content: '回答一' }), user({ id: 'u2' })],
      { key: 'u1', version: 0 },
    )
    expect(seed.map((r) => r.content)).toEqual(['回答一'])
  })
})

describe('answersOfVersion / answerPatch', () => {
  it('★ 按提问版本挑回答（切版本时不能把另一版的回答端上来）', () => {
    const records = [record('答第一版', 0), record('答第二版', 1)]
    expect(answersOfVersion(records, 0).map((r) => r.content)).toEqual(['答第一版'])
    expect(answersOfVersion(records, 1).map((r) => r.content)).toEqual(['答第二版'])
  })

  it('没有 answerRecords 的老消息 → 空数组（界面就不显示切换器）', () => {
    expect(answersOfVersion(undefined, 0)).toEqual([])
  })

  it('切换 = 换一条显示：内容/思考/工具/引用都跟着换，不新增消息', () => {
    const patch = answerPatch(record('第二遍'), 1)
    expect(patch.content).toBe('第二遍')
    expect(patch.answerIndex).toBe(1)
    expect(patch.status).toBe('sent')
  })
})

describe('toAnswerRecord', () => {
  it('★ 带上的回答标记能落盘（读会话时靠它分组，老记录没有就退化成位置认领）', () => {
    const r = toAnswerRecord(
      assistant({ id: 'a1', content: '回答', answersKey: 'u1', answersVersion: 1 }),
    )
    expect(r.answersKey).toBe('u1')
    expect(r.answersVersion).toBe(1)
    expect(r.key).toBe('a1')
  })

  it('工具 / 引用 / token 一起带过去（切回去时不能变空）', () => {
    const r = toAnswerRecord(
      assistant({
        toolRuns: [{ id: 't1', name: 'read_file', ok: true, output: 'ok' }],
        citations: [{ id: 'c1', kind: 'web', title: '来源' }],
      }),
    )
    expect(r.toolRuns?.length).toBe(1)
    expect(r.citations?.length).toBe(1)
  })
})
