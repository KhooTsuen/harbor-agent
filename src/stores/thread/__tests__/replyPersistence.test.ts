import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReplyPersistence } from '../replyPersistence'
import { useAppStore } from '@/stores/useAppStore'
import type { StoredMessage } from '@/types/backend'
import type { Message } from '@/types'

/* ══════════════════════════════════════════════════════════════
   助手回复的落盘

   两件事都要钉住：
     ① 流式过程中**分段落盘**（进程被强杀时才有东西可留）
     ② 收尾那条带**同一个 key**（读的一侧靠它把几行收敛成一条）

   还有两条边界：error 不落盘（把报错当历史喂回模型没意义）、空回复不落盘
   （免得会话里多一条空消息）。
   ══════════════════════════════════════════════════════════════ */

const written: Array<{ id: string; message: StoredMessage }> = []

beforeEach(() => {
  written.length = 0
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-22T10:00:00Z'))
  useAppStore.setState({
    persistMessage: (id: string, message: StoredMessage) => {
      written.push({ id, message })
    },
  } as never)
})

afterEach(() => {
  vi.useRealTimers()
})

/** 造一份「线程里那条占位消息现在长什么样」 */
function seedThread(content: string, extra: Partial<Message> = {}): void {
  useAppStore.setState({
    threads: [
      {
        id: 't1',
        messages: [
          { id: 'user_1', role: 'user', content: '帮我改 README', timestamp: 1 },
          { id: 'msg_1', role: 'assistant', content, timestamp: 2, ...extra },
        ],
      },
    ],
  } as never)
}

function make(
  overrides: {
    content?: string
    reasoning?: string
    event?: string
    answersKey?: string
    answersVersion?: number
  } = {},
) {
  let content = overrides.content ?? ''
  let reasoning = overrides.reasoning ?? ''
  let event = overrides.event ?? 'done'
  const persistence = createReplyPersistence({
    threadId: 't1',
    messageId: 'msg_1',
    timestamp: 2,
    ...(overrides.answersKey ? { answersKey: overrides.answersKey } : {}),
    ...(overrides.answersVersion !== undefined ? { answersVersion: overrides.answersVersion } : {}),
    getContent: () => content,
    getReasoning: () => reasoning,
    getEventType: () => event,
  })
  return {
    persistence,
    setContent: (v: string) => {
      content = v
    },
    setEvent: (v: string) => {
      event = v
    },
  }
}

describe('分段落盘', () => {
  it('★ 内容长了 + 隔够时间 → 写一条 partial，带 key', () => {
    const { persistence, setContent } = make()
    setContent(
      '好，我分两步做：先读 README 和 tests.py 确认依赖，再把安装那一节改成一行脚本，最后跑一遍 tests.py 确认没坏。',
    )
    persistence.flushPartial()

    expect(written).toHaveLength(1)
    expect(written[0].id).toBe('t1')
    expect(written[0].message.partial).toBe(true)
    expect(written[0].message.key).toBe('msg_1')
    expect(written[0].message.content).toContain('先读 README')
  })

  it('★ 刚写完就再调一次 → 不重复写（这就是「分段落盘」不是「每个 token 一条」）', () => {
    const { persistence, setContent } = make()
    setContent(
      '好，我分两步做：先读 README 和 tests.py 确认依赖，再把安装那一节改成一行脚本，最后跑一遍 tests.py 确认没坏。',
    )
    persistence.flushPartial()
    vi.advanceTimersByTime(200)
    persistence.flushPartial()
    expect(written).toHaveLength(1)
  })

  it('内容还太短就不写（短回答只留收尾那条就够）', () => {
    const { persistence, setContent } = make()
    setContent('好')
    persistence.flushPartial()
    expect(written).toHaveLength(0)
  })

  it('思考过程跟着快照一起留（重开时还看得到它当时在想什么）', () => {
    const { persistence, setContent } = make({ reasoning: '先看看 README 有多长' })
    setContent(
      '好，我分两步做：先读 README 和 tests.py 确认依赖，再把安装那一节改成一行脚本，最后跑一遍 tests.py 确认没坏。',
    )
    persistence.flushPartial()
    expect(written[0].message.reasoning).toContain('先看看')
  })
})

describe('收尾落盘', () => {
  it('★ done：写完整那条，带同一个 key、不带 partial', () => {
    const { persistence } = make({ event: 'done' })
    seedThread('好，我分两步：先读 README，再改。改完了。')
    persistence.persistReply()

    expect(written).toHaveLength(1)
    expect(written[0].message.key).toBe('msg_1')
    expect(written[0].message.partial).toBe(undefined)
    expect(written[0].message.content).toContain('改完了')
  })

  it('★ aborted 也写（用户自己按停的，半截回复也是结果）', () => {
    const { persistence } = make({ event: 'aborted' })
    seedThread('写到一半就被停了')
    persistence.persistReply()
    expect(written).toHaveLength(1)
  })

  it('★ error 不写（把报错当历史喂回模型没有意义）', () => {
    const { persistence } = make({ event: 'error' })
    seedThread('供应商 401')
    persistence.persistReply()
    expect(written).toHaveLength(0)
  })

  it('空回复不写（免得会话里多一条空的）', () => {
    const { persistence } = make({ event: 'done' })
    seedThread('   ')
    persistence.persistReply()
    expect(written).toHaveLength(0)
  })

  it('空文字但跑过工具 → 还是写（工具记录有价值）', () => {
    const { persistence } = make({ event: 'done' })
    seedThread('', { toolRuns: [{ id: 't', name: 'read_file', ok: true, output: 'x' }] })
    persistence.persistReply()
    expect(written).toHaveLength(1)
    expect(written[0].message.toolRuns).toHaveLength(1)
  })
})

describe('★ 回答要标上「答的是哪条提问、第几版」', () => {
  /*
   * 用户报的 bug 根子就在这里：提问有多版本，回答却没标「我答的是哪一版」，
   * 读会话时也就认不出「同一次提问的几次生成」，于是并排堆着。
   * 这两个字段必须**真的落到磁盘记录上** —— 只在内存里带是没用的。
   */
  it('收尾那条带上 answersKey / answersVersion', () => {
    /* ★ 必须自己种一条：persistReply 读的是 store 里那条消息，
       不 seedThread 就是在赌"前面那个用例恰好留下了什么"（这个坑踩过好几次） */
    seedThread('回答', { answersKey: 'u9', answersVersion: 1 })
    const { persistence } = make({ answersKey: 'u9', answersVersion: 1 })
    persistence.persistReply()
    expect(written[0]).toBeDefined()
    expect(written[0]!.message.answersKey).toBe('u9')
    expect(written[0]!.message.answersVersion).toBe(1)
  })

  it('分段快照也带（只留快照时也得认得回来）', () => {
    seedThread('长'.repeat(60))
    const { persistence, setContent } = make({ answersKey: 'u9', answersVersion: 0 })
    setContent('长'.repeat(60))
    persistence.flushPartial()
    expect(written[0]?.message.partial).toBe(true)
    expect(written[0]?.message.answersKey).toBe('u9')
  })

  it('没有提问（比如首条就是助手）就不带这两个字段', () => {
    seedThread('回答')
    const { persistence } = make()
    persistence.persistReply()
    expect(written[0]?.message.answersKey).toBeUndefined()
  })
})
