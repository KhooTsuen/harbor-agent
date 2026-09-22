import type { Message } from '@/types'
import type { TurnSetter } from './turns'
import { runElectronTurn } from './turns'
import { runMockTurn } from './mockTurn'
import { getActiveThread, useAppStore } from '../useAppStore'
import { useUIStore } from '../useUIStore'
import { useRealBackend } from '@/lib/backend'

/* ══════════════════════════════════════════════════════════════
   用户消息的「多版本」与从某条消息重跑

   为什么要有这个东西：编辑一条已经发出去的消息时，以前的做法是
   **改文字 + 再发一条新消息**（`sendMessage` 一定会 `addMessage`）——
   结果是会话里出现**两条一模一样的提问**（用户报的正是这个）。
   另一处同源的问题：`regenerateMessage` 删掉助手那条之后同样调 `sendMessage`，
   于是用户那句也被复制了一份。

   根因是同一个：**`sendMessage` 是「用户又说了句话」，不是「用现有历史重跑」**。
   这里改成后者 —— 直接调 `runElectronTurn`（它本来就不看传进去的文本，
   历史是从 store 里读的），一个消息都不会新增。

   顺带把「改过几版」记在同一条消息上（`versions` / `versionIndex`）：
   编辑一次 = 多一个版本，界面上是 `‹ 2 / 2 ›` 切换，而不是多出一条消息。
   切版本时重新回答那一版 —— 否则回答还是按旧版本写的，就成了答非所问。
   ══════════════════════════════════════════════════════════════ */

type Getter = () => {
  sendingThreads: string[]
}

/** 记一版新文字：第一次编辑时把原文也补进版本表，之后每次往后追 */
export function pushVersion(message: Message, text: string): Partial<Message> {
  const versions = [...(message.versions ?? [message.content])]
  if (versions[versions.length - 1] !== text) versions.push(text)
  return { content: text, versions, versionIndex: versions.length - 1, edited: true }
}

/** 切到第 index 版；越界返回 null（调用方什么都不做） */
export function activateVersion(message: Message, index: number): Partial<Message> | null {
  const versions = message.versions ?? [message.content]
  if (index < 0 || index >= versions.length) return null
  const text = versions[index]
  if (text === undefined) return null
  return { content: text, versions, versionIndex: index }
}

export function makeVersionActions(set: TurnSetter, get: Getter) {
  /** 从某条消息往下重跑（先把它之后的消息丢掉），**不新增任何消息** */
  function rerunFrom(threadId: string, messageId: string, text: string): void {
    if (get().sendingThreads.includes(threadId)) {
      useUIStore.getState().showToast('info', '正在生成', '等这一轮结束再改，不然会跟它抢上下文')
      return
    }
    const app = useAppStore.getState()
    const thread = app.threads.find((t) => t.id === threadId)
    if (!thread) return
    /*
     * 落盘：同一 key 追加一条新记录，读的时候按 key 收敛成一条
     * （不会变成"两条一样的提问"）；版本表一起带上，重启后还能切回去。
     */
    const edited = app.threads
      .find((t) => t.id === threadId)
      ?.messages.find((m) => m.id === messageId)
    if (edited) {
      app.persistMessage(threadId, {
        role: 'user',
        key: messageId,
        content: edited.content,
        ts: edited.timestamp,
        ...(edited.versions ? { versions: edited.versions } : {}),
        ...(edited.versionIndex !== undefined ? { versionIndex: edited.versionIndex } : {}),
      } as never)
    }
    /* 后面的回答是按旧内容写的，留着会答非所问 */
    app.removeMessagesAfter(threadId, messageId)
    if (useRealBackend) void runElectronTurn(threadId, text, set, '')
    else void runMockTurn(threadId, text, set)
  }

  return {
    /** 编辑并重新回答：同一条消息多加一版，然后按新内容重跑 */
    editAndRerun: (threadId: string, messageId: string, text: string) => {
      const app = useAppStore.getState()
      const message = app.threads
        .find((t) => t.id === threadId)
        ?.messages.find((m) => m.id === messageId)
      if (!message) return
      app.updateMessage(threadId, messageId, pushVersion(message, text))
      rerunFrom(threadId, messageId, text)
    },

    /** 切到某一版（界面上 ‹ n / N ›）：换内容 + 重新回答那一版 */
    activateUserVersion: (threadId: string, messageId: string, index: number) => {
      const app = useAppStore.getState()
      const message = app.threads
        .find((t) => t.id === threadId)
        ?.messages.find((m) => m.id === messageId)
      if (!message) return
      const patch = activateVersion(message, index)
      if (!patch) return
      app.updateMessage(threadId, messageId, patch)
      rerunFrom(threadId, messageId, patch.content ?? '')
    },

    /**
     * 重新生成这条回答。
     *
     * 从「这条回答」往前找到最近的那句用户消息，把两者之后的消息都丢掉再重跑。
     * ★ 以前它调 `sendMessage(userText)` —— 那是「用户又说了句话」，
     *   会把用户那句**再复制一份**（和编辑那边同一个 bug）。
     */
    regenerateMessage: (messageId: string) => {
      const app = useAppStore.getState()
      const thread = getActiveThread(app)
      if (!thread) return
      const index = thread.messages.findIndex((m) => m.id === messageId)
      if (index < 0) return

      let userText = ''
      let userId = ''
      for (let i = index - 1; i >= 0; i -= 1) {
        const m = thread.messages[i]
        if (m && m.role === 'user') {
          userText = m.content
          userId = m.id
          break
        }
      }
      if (!userText || !userId) return
      rerunFrom(thread.id, userId, userText)
    },
  }
}
