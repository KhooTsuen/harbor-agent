import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeLiveMessages } from '../diskActions'
import { createReplyPersistence } from '@/stores/thread/replyPersistence'
import { useAppStore } from '@/stores/useAppStore'
import type { Message } from '@/types'
import type { StoredMessage } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
    「注入不能把正在流式的那一轮顶掉」

    2026-11-04 真机：用户开着一条回复在流式，扩展送进来页面内容 →
    界面就不动了，但后台还在跑。两件事在同一个事故的两端，所以放一起钉：

      ① 重读盘时的合并（`mergeLiveMessages`）—— 界面那条还在不在
      ② 收尾落盘的兜底（`createReplyPersistence().persistReply`）—— 正文丢不丢
    ══════════════════════════════════════════════════════════════ */

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    threadId: 't1',
    role: 'assistant',
    content: '',
    kind: 'text',
    status: 'sent',
    timestamp: 100,
    ...over,
  }
}

describe('重读盘 · 保住正在跑的那一轮', () => {
  it('没有在跑的一轮 → 原样用磁盘那份（老行为零变化）', () => {
    const disk = [msg({ id: 'd1', diskKey: 'k1', content: '历史' })]
    const current = [msg({ id: 'm1', content: '内存里的一份' })]
    expect(mergeLiveMessages(disk, current)).toBe(disk)
  })

  it('★★★ 有在跑的那一轮 → 它还在，且 id 不变（不然之后每个分片都找不到它）', () => {
    const live = msg({ id: 'live1', status: 'streaming', content: '正在写' })
    const merged = mergeLiveMessages([msg({ id: 'd1', diskKey: 'k1' })], [live])
    expect(merged.some((m) => m.id === 'live1')).toBe(true)
    expect(merged.find((m) => m.id === 'live1')?.status).toBe('streaming')
  })

  it('★★ 磁盘上同 key 的分段快照要丢掉（同一轮不能出现两条、其中一条还是半截）', () => {
    const live = msg({ id: 'live1', status: 'streaming', content: '正在写' })
    /* 快照写盘时用占位消息的 id 当 key → 读回落在 diskKey 上 */
    const snapshot = msg({ id: 'd9', diskKey: 'live1', content: '几秒前那半截', interrupted: true })
    const merged = mergeLiveMessages([msg({ id: 'd1', diskKey: 'k1' }), snapshot], [live])
    expect(merged.some((m) => m.content === '几秒前那半截')).toBe(false)
    expect(merged.filter((m) => m.diskKey === 'live1')).toHaveLength(0)
  })

  it('★ 注入进来的那条要留下（它就在磁盘那份里），并且排在在跑的那条前面', () => {
    const live = msg({ id: 'live1', status: 'streaming', content: '正在写', timestamp: 200 })
    const injected = msg({
      id: 'd2',
      diskKey: 'k2',
      role: 'user',
      source: 'extension',
      content: '【以下是通过你 Edge 当前标签读到的网页内容…】',
      timestamp: 300,
    })
    const merged = mergeLiveMessages(
      [msg({ id: 'd1', diskKey: 'k1' }), injected],
      [live, msg({ id: 'u0' })],
    )
    const at = merged.findIndex((m) => m.source === 'extension')
    expect(at).toBeGreaterThan(-1)
    expect(merged[merged.length - 1]?.id).toBe('live1')
  })

  it('内存里刚发、磁盘上还没有的提问要保住（点继续那一刻）', () => {
    const live = msg({ id: 'live1', status: 'streaming', timestamp: 500 })
    const fresh = msg({ id: 'u1', role: 'user', content: '继续刚才的任务', timestamp: 400 })
    const merged = mergeLiveMessages(
      [msg({ id: 'd1', diskKey: 'k1', timestamp: 100 })],
      [fresh, live],
    )
    expect(merged.some((m) => m.content === '继续刚才的任务')).toBe(true)
  })

  it('老会话里那些更早的消息不会被误留（只按「晚于磁盘最新一条」取）', () => {
    const live = msg({ id: 'live1', status: 'streaming', timestamp: 500 })
    const oldLocal = msg({ id: 'o1', content: '很久以前的一条', timestamp: 50 })
    const merged = mergeLiveMessages(
      [msg({ id: 'd1', diskKey: 'k1', timestamp: 100 })],
      [oldLocal, live],
    )
    expect(merged.some((m) => m.content === '很久以前的一条')).toBe(false)
  })
})

describe('收尾落盘 · 找不到那条消息时不能整轮丢掉', () => {
  const written: Array<{ id: string; message: StoredMessage }> = []

  beforeEach(() => {
    written.length = 0
    useAppStore.setState({
      threads: [{ id: 't1', messages: [] }],
      persistMessage: (id: string, message: StoredMessage) => {
        written.push({ id, message })
      },
    } as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('★★★ 界面那条被顶掉了，正文照样写盘（以前这里一个字都不写）', () => {
    const persistence = createReplyPersistence({
      threadId: 't1',
      messageId: 'gone',
      timestamp: 2,
      getContent: () => '这一轮真正写出来的正文',
      getReasoning: () => '想过一段',
      getEventType: () => 'done',
    })
    persistence.persistReply()
    expect(written).toHaveLength(1)
    expect(written[0]?.message.content).toBe('这一轮真正写出来的正文')
    expect(written[0]?.message.key).toBe('gone')
    expect(written[0]?.message.reasoning).toBe('想过一段')
  })

  it('空正文仍然不写（老规矩：会话里别多一条空消息）', () => {
    const persistence = createReplyPersistence({
      threadId: 't1',
      messageId: 'gone',
      timestamp: 2,
      getContent: () => '   ',
      getReasoning: () => '',
      getEventType: () => 'done',
    })
    persistence.persistReply()
    expect(written).toHaveLength(0)
  })

  it('error 仍然不落盘（把报错当历史喂回模型没意义）', () => {
    const persistence = createReplyPersistence({
      threadId: 't1',
      messageId: 'gone',
      timestamp: 2,
      getContent: () => '报错前写的一点内容',
      getReasoning: () => '',
      getEventType: () => 'error',
    })
    persistence.persistReply()
    expect(written).toHaveLength(0)
  })
})
