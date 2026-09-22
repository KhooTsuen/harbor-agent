import type { Message } from '@/types'
import type { TurnSetter } from './turns'
import { runElectronTurn } from './turns'
import { runMockTurn } from './mockTurn'
import { getActiveThread, useAppStore } from '../useAppStore'
import { useUIStore } from '../useUIStore'
import { useRealBackend } from '@/lib/backend'
import { answersOfVersion, allAnswers, answerPatch, existingAnswersAfter } from '@/lib/answers'

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
  /**
   * 把「这条提问现在显示第几版」写进磁盘。
   *
   * 必须写 —— 否则重开会话又回到最后一版（用户切到第 1 版、重开变回第 2 版）。
   * 版本表一起带上，重开还能继续切。
   */
  function persistVersion(threadId: string, message: Message): void {
    useAppStore.getState().persistMessage(threadId, {
      role: 'user',
      key: message.id,
      content: message.content,
      ts: message.timestamp,
      ...(message.versions ? { versions: message.versions } : {}),
      ...(message.versionIndex !== undefined ? { versionIndex: message.versionIndex } : {}),
    } as never)
  }

  /** 从某条消息往下重跑（先把它之后的消息丢掉），**不新增任何消息** */
  function rerunFrom(
    threadId: string,
    messageId: string,
    text: string,
    /**
     * 被换掉的那条回答属于哪一版提问。
     *
     * ★ 一定要带上：内存里那条回答（`removeMessagesAfter` 之前抓下来的）没有
     *   「答的是第几版」的标记，不标就会落到默认的第 0 版 —— 于是切回原来那一版时
     *   找不到它、又跑一轮（真机上验证时就是这么发现的）。
     */
    seedVersion?: number,
    /** 只给日志用：这一轮是编辑 / 重新生成 / 切版本触发的 */
    reason = '用户发送',
  ): void {
    if (get().sendingThreads.includes(threadId)) {
      useUIStore.getState().showToast('info', '正在生成', '等这一轮结束再改，不然会跟它抢上下文')
      return
    }
    const app = useAppStore.getState()
    const thread = app.threads.find((t) => t.id === threadId)
    if (!thread) return
    /* 落盘：同一 key 追加一条新记录，读的时候按 key 收敛成一条
       （不会变成"两条一样的提问"）；版本表一起带上，重启后还能切回去。 */
    const edited = app.threads
      .find((t) => t.id === threadId)
      ?.messages.find((m) => m.id === messageId)
    if (edited) persistVersion(threadId, edited)
    /* 这条提问原来那条回答先抓下来（下一步就把它从列表里删掉了）——
       它是「回答的历史版本」，切回去时要能拿出来，不能只剩磁盘上有 */
    const previous = existingAnswersAfter(thread.messages, { key: messageId, version: 0 }).map(
      (record) => (seedVersion === undefined ? record : { ...record, answersVersion: seedVersion }),
    )
    /* 后面的回答是按旧内容写的，留着会答非所问 */
    app.removeMessagesAfter(threadId, messageId)
    if (useRealBackend) {
      void runElectronTurn(threadId, text, set, '', { seedAnswers: previous, reason })
    } else void runMockTurn(threadId, text, set)
  }

  return {
    /** 编辑并重新回答：同一条消息多加一版，然后按新内容重跑 */
    editAndRerun: (threadId: string, messageId: string, text: string) => {
      const app = useAppStore.getState()
      const message = app.threads
        .find((t) => t.id === threadId)
        ?.messages.find((m) => m.id === messageId)
      if (!message) return
      /* 改之前那一版：被换掉的回答属于它 */
      const wasVersion = message.versionIndex ?? 0
      app.updateMessage(threadId, messageId, pushVersion(message, text))
      rerunFrom(threadId, messageId, text, wasVersion, '编辑后重答')
    },

    /**
     * 切到某一版提问（界面上 ‹ n / N ›）。
     *
     * ★ 那一版**回答过**就直接把它当年那条回答换上来 —— **不重跑**。
     *   以前一律重跑，于是每切一次就多一个回答，堆在会话里（用户报的 bug）。
     *   只有从没回答过的那一版才需要真跑一轮。
     */
    activateUserVersion: (threadId: string, messageId: string, index: number) => {
      const app = useAppStore.getState()
      const thread = app.threads.find((t) => t.id === threadId)
      const message = thread?.messages.find((m) => m.id === messageId)
      if (!thread || !message) return
      const patch = activateVersion(message, index)
      if (!patch) return
      app.updateMessage(threadId, messageId, patch)
      persistVersion(threadId, { ...message, ...patch })

      const at = thread.messages.findIndex((m) => m.id === messageId)
      const answer = thread.messages[at + 1]
      /* ★ allAnswers：把「当前这条回答自己」也算上，否则切回刚生成的那一版会又跑一轮 */
      const records = answersOfVersion(answer ? allAnswers(answer) : [], index)
      if (answer && records.length) {
        app.updateMessage(
          threadId,
          answer.id,
          answerPatch(records[records.length - 1]!, records.length - 1),
        )
        return
      }
      rerunFrom(threadId, messageId, patch.content ?? '', index, '切提问版本')
    },

    /** 切到这条提问的第几条回答（界面上回答下面的 ‹ n / N ›）—— 不重跑 */
    activateAnswer: (threadId: string, messageId: string, index: number) => {
      const app = useAppStore.getState()
      const thread = app.threads.find((t) => t.id === threadId)
      const message = thread?.messages.find((m) => m.id === messageId)
      const records = answersOfVersion(
        message ? allAnswers(message) : [],
        message?.answersVersion ?? 0,
      )
      const record = records[index]
      if (!message || !record) return
      app.updateMessage(threadId, messageId, answerPatch(record, index))
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
      const question = thread.messages.find((m) => m.id === userId)
      rerunFrom(thread.id, userId, userText, question?.versionIndex ?? 0, '重新生成')
    },
  }
}
