import type { Message, Thread } from '@/types'
import { touch } from './types'

/* ══════════════════════════════════════════════════════════════
   消息级操作

   从 useAppStore 拆出来的：那边已经 300 行出头，而这一组
   （加/改/删/清空消息）是完整的一块，内聚得很好。

   写法：接收 set，返回一组 action —— 这样不用把 store 本体
   import 进去（那会绕成循环依赖）。
   ══════════════════════════════════════════════════════════════ */

type Setter = (updater: (state: { threads: Thread[] }) => { threads: Thread[] }) => void

/** 把某个 thread 的 messages 换成新的 */
function patchMessages(
  set: Setter,
  threadId: string,
  mapper: (messages: Message[]) => Message[],
): void {
  set((s) => ({
    threads: s.threads.map((t) =>
      t.id === threadId ? touch({ ...t, messages: mapper(t.messages) }) : t,
    ),
  }))
}

export function makeMessageActions(set: Setter) {
  return {
    addMessage: (threadId: string, message: Message) =>
      patchMessages(set, threadId, (messages) => [...messages, message]),

    updateMessage: (threadId: string, messageId: string, patch: Partial<Message>) =>
      patchMessages(set, threadId, (messages) =>
        messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
      ),

    removeMessage: (threadId: string, messageId: string) =>
      patchMessages(set, threadId, (messages) => messages.filter((m) => m.id !== messageId)),

    clearMessages: (threadId: string) => patchMessages(set, threadId, () => []),
  }
}
