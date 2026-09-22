import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/stores/useAppStore'
import type { Message } from '@/types'

/* ══════════════════════════════════════════════════════════════
   removeMessagesAfter：把某条之后的消息都删掉

   「编辑并重新回答」在重发之前要先把后面那些**按旧问题写的**回答丢掉，
   否则会话里会留着一条答非所问的回复。这里钉住它的边界：

   · 这条自己必须留着（新内容还要用）
   · 找不到这条 id 时**什么都不动** —— 一个笔误不能把整条对话清空
   ══════════════════════════════════════════════════════════════ */

const msg = (id: string, role: Message['role'], content: string): Message => ({
  id,
  threadId: 't1',
  role,
  content,
  kind: 'text',
  status: 'sent',
  timestamp: 1,
})

beforeEach(() => {
  useAppStore.setState({
    threads: [
      {
        id: 't1',
        title: '测试',
        workdir: '',
        messages: [
          msg('u1', 'user', '第一问'),
          msg('a1', 'assistant', '第一答'),
          msg('u2', 'user', '再问'),
          msg('a2', 'assistant', '再答'),
        ],
      },
    ],
  } as never)
})

const contents = () => useAppStore.getState().threads[0].messages.map((m) => m.content)

describe('removeMessagesAfter', () => {
  it('★ 删掉这条之后的，这条自己留着', () => {
    useAppStore.getState().removeMessagesAfter('t1', 'u1')
    expect(contents()).toEqual(['第一问'])
  })

  it('从中间删：前面和它自己保留', () => {
    useAppStore.getState().removeMessagesAfter('t1', 'u2')
    expect(contents()).toEqual(['第一问', '第一答', '再问'])
  })

  it('★ 找不到这条 id → 一条都不许动（笔误不能清空对话）', () => {
    useAppStore.getState().removeMessagesAfter('t1', '不存在的id')
    expect(contents()).toHaveLength(4)
  })

  it('删别的线程时不影响这条线程', () => {
    useAppStore.getState().removeMessagesAfter('别的线程', 'u1')
    expect(contents()).toHaveLength(4)
  })
})
