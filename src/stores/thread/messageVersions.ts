import type { Message } from '@/types'
import type { TurnSetter } from './turns'
import { runElectronTurn } from './turns'
import { runMockTurn } from './mockTurn'
import { useAppStore } from '../useAppStore'
import { useUIStore } from '../useUIStore'
import { useRealBackend } from '@/lib/backend'
import { makeRegenerate } from './regenerate'
import { setRegenRunner } from './regenQueue'
import {
  answerVersionRerun,
  findQuestion,
  offerAnswerVersion,
  persistVersion,
} from './versionLookup'
import {
  answersOfVersion,
  allAnswers,
  answerPatch,
  existingAnswersAfter,
  questionOf,
  pickAnswer,
  toAnswerRecord,
} from '@/lib/answers'

/* ══════════════════════════════════════════════════════════════
   用户消息的「多版本」与从某条消息重跑

   历史：编辑已发出的消息，以前是「改文字 + 再发一条」（sendMessage 一定 addMessage）
   → 会话里出现两条一模一样的提问；regenerateMessage 同源（复制用户那句）。
   根因：sendMessage 是「用户又说了句话」，不是「用现有历史重跑」。这里改直调
   runElectronTurn（它不看传入文本，历史从 store 读），一条消息都不新增。

   「改过几版」记在同一条消息上（versions/versionIndex）：编辑一次 = 多一版，
   界面是 `‹ 2 / 2 ›` 切换。★ 切版本本身**不重跑**；没回答过的那一版只弹提示，
   点「补一版回答」才跑（细节见 versionLookup.ts）。
   ══════════════════════════════════════════════════════════════ */

type Getter = () => {
  sendingThreads: string[]
  /** 提示里的「补一版回答」按钮会回调它（定义在本文件的返回对象里） */
  answerVersion: (
    threadId: string,
    text: string,
    versions: string[] | undefined,
    index: number,
  ) => void
  /** 「先停掉、收尾后再跑」的排队重新生成会回调它（同上，定义在本文件的返回对象里） */
  regenerateMessage: (messageId: string) => void
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
  function rerunFrom(
    threadId: string,
    messageId: string,
    text: string,
    /**
     * 被换掉的那条回答属于哪一版提问。 ★ 只给**没有标记**的旧记录补标——
     * 已标过的一律保持原样。以前是无条件重标：在 B（第 1 版）下重新生成时，
     * A（第 0 版）的每条回答全被改成「第 1 版」→ B 的切换器把 A 的版本一起
     * 数进去（用户报的 1/8、1/9），切回 A 又一条都找不到。
     */
    seedVersion?: number,
    /** 只给日志用：这一轮是编辑 / 重新生成 / 重试 / 补一版回答触发的 */
    reason = '用户发送',
    /** 重新生成的附加信息：旧回答的磁盘 key + 是不是最后一轮（见 regenerate.ts） */
    extra: { regeneratedFrom?: string; regenerateIsLast?: boolean } = {},
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
       它是「回答的历史版本」，切回去时要能拿出来，不能只剩磁盘上有。
       ★ 版本标记**只补缺、不重贴**：每条回答属于哪一版是它生成时就定下的，
         重贴会把别的版本的回答吞进当前版（见 seedVersion 的注释）。 */
    const previous = existingAnswersAfter(thread.messages, { key: messageId, version: 0 }).map(
      (record) =>
        seedVersion === undefined || record.answersVersion !== undefined
          ? record
          : { ...record, answersVersion: seedVersion },
    )
    /* 后面的回答是按旧内容写的，留着会答非所问 */
    app.removeMessagesAfter(threadId, messageId)
    if (useRealBackend) {
      void runElectronTurn(threadId, text, set, '', {
        seedAnswers: previous,
        reason,
        ...(extra.regeneratedFrom ? { regeneratedFrom: extra.regeneratedFrom } : {}),
        ...(extra.regenerateIsLast ? { regenerateIsLast: true } : {}),
      })
    } else void runMockTurn(threadId, text, set)
  }

  /**
   * 「这一版还没有回答过」的提示 + 一键补答。
   *
   * ★ 这里**只是提示**：切版本 / 切会话只负责换显示，跑不跑由用户点
   *   （真机日志：以前切版本会直接 rerunFrom，连点四次切换 = 四次 chat:send）。
   *   提示本体在 `versionLookup.ts`；这里只把按钮接到本文件的 `answerVersion`。
   */
  function offerAnswer(
    threadId: string,
    text: string,
    versions: string[] | undefined,
    index: number,
  ): void {
    const onConfirm = () => get().answerVersion(threadId, text, versions, index)
    offerAnswerVersion(onConfirm)
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
     * 切到某一版提问（界面上 ‹ n / N ›）—— 只换显示，**不跑生成**。
     *
     * ★ 顺序要紧：① 把「选了哪一版」写盘（同一 key 追加版本记录）
     *   ② **重读这个会话**。为什么必须重读：编辑中间那条时，后面几轮（按旧内容
     *   写的）被撤下界面但**还在磁盘上**（带"接在哪一版后面"的标记）；重读后内核
     *   按选中版本筛，切回旧版本那几轮**自己就回来了**，不重读永远回不来。
     *   先写盘、再重读、中间不碰内存 —— openFromDisk 的覆盖保护正好放行。
     *
     * ★ 回答过的那一版：重读后它自己就在，什么都不用做。
     * ★ 没回答过的：只弹提示（以前直接 rerunFrom，真机连点四次切换 = 四次
     *   chat:send，用户点完 4 秒后又慌忙点「停止生成」）。点不点由用户决定。
     */
    activateUserVersion: (threadId: string, messageId: string, index: number) => {
      const app = useAppStore.getState()
      const thread = app.threads.find((t) => t.id === threadId)
      const message = thread?.messages.find((m) => m.id === messageId)
      if (!thread || !message) return
      const patch = activateVersion(message, index)
      if (!patch) return
      /* 正在生成时别重读：会把流式那条抹掉（和 rerunFrom 一个道理） */
      if (get().sendingThreads.includes(threadId)) {
        useUIStore.getState().showToast('info', '正在生成', '等这一轮结束再切，不然会跟它抢上下文')
        return
      }
      persistVersion(threadId, { ...message, ...patch })

      if (!useRealBackend) {
        /* 浏览器预览：没有磁盘可读，退回"换内容 + 有回答就换上" */
        app.updateMessage(threadId, messageId, patch)
        const at = thread.messages.findIndex((m) => m.id === messageId)
        const answer = thread.messages[at + 1]
        const records = answersOfVersion(answer ? allAnswers(answer) : [], index)
        if (answer && records.length) {
          app.updateMessage(
            threadId,
            answer.id,
            answerPatch(records[records.length - 1]!, records.length - 1),
          )
          return
        }
        /* 没回答过也不自动跑 —— 和真后端同一规矩：点提示里的按钮才跑 */
        offerAnswer(threadId, patch.content ?? '', message.versions, index)
        return
      }

      /*
       * ★ 重读之后**不能按 id 找** —— 重读会给每条消息换一个新 uid
       *   （`storedToUi` 里是 `uid('msg')`），老 id 一定找不到；找不到会被
       *   当成「这一版没回答过」而误跑一轮（真机日志里就是这么连续跑起来的）。
       *   按签名找回；找不回就什么都不做（宁可不动，也不能误跑）。
       */
      void (async () => {
        await useAppStore.getState().openFromDisk(threadId)
        const fresh = useAppStore.getState().threads.find((t) => t.id === threadId)
        if (!fresh) return
        const at = fresh.messages.findIndex((m) => m.id === messageId)
        const direct = at >= 0 ? fresh.messages[at] : undefined
        const question =
          direct ??
          findQuestion(
            fresh.messages,
            patch.content ?? '',
            message.versions,
            index,
            message.timestamp,
          )
        if (!question) return
        const answer = fresh.messages[fresh.messages.indexOf(question) + 1]
        const records =
          answer && answer.role === 'assistant' ? answersOfVersion(allAnswers(answer), index) : []
        if (records.length) return
        offerAnswer(threadId, patch.content ?? '', question.versions, index)
      })()
    },

    /**
     * 给某一版提问「补一版回答」—— 由提示里的按钮调用，**只有用户点了才跑**。
     *
     * ★ 具体执行在 `versionLookup.ts` 的 `answerVersionRerun`：重新按签名找一遍。
     */
    answerVersion: (
      threadId: string,
      text: string,
      versions: string[] | undefined,
      index: number,
    ) => {
      answerVersionRerun(threadId, text, versions, index, (questionId) =>
        /* rerunFrom 里还有「正在生成」守卫：不会跟正在跑的这轮抢上下文 */
        rerunFrom(threadId, questionId, text, undefined, '补一版回答'),
      )
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
      if (!thread || !message || !record) return
      /*
       * ★ 切走之前先把「自己」定格进台账（原文 = 现在显示的内容）。
       *   不定格的话，「自己」跟着 message.content 走：切到别的回答会把它盖成
       *   那条的内容，再切回来第 N 版显示的就是别版 —— 三个版本里有一个的原文丢了。
       *   （allAnswers 只在台账里没有自己时才补记，所以定格必须发生在这里。）
       */
      const self = toAnswerRecord(message)
      const inLedger = (message.answerRecords ?? []).some((r) => r.key === self.key)
      const next: Partial<Message> = answerPatch(record, index)
      if (!inLedger) next.answerRecords = [...(message.answerRecords ?? []), self]
      /* 内存里换一条显示 —— 不新增消息、不重跑 */
      app.updateMessage(threadId, messageId, next)
      /*
       * ★ 选择要落盘（以前只有「选了哪一版提问」落了盘）。
       *   不写的话重开会话又跳回最新那条 —— 用户选的那版白选了。
       *   记在**提问**记录上、按提问版本分开存（见 lib/answers.ts 的 pickAnswer）；
       *   读的一侧（内核 pickedIndex）按它决定露哪条。
       */
      const question = questionOf(thread.messages, message)
      if (!question) return
      const patch = pickAnswer(question, message.answersVersion ?? 0, index)
      app.updateMessage(threadId, question.id, patch)
      persistVersion(threadId, { ...question, ...patch })
    },

    /**
     * 重新生成 / 重试 —— 实现搬去 `thread/regenerate.ts`；流式中止、排队收尾、
     * 连续重试提示、台账关联（regeneratedFrom）都在那边。
     *
     * ★ 实现**不在模块初始化时取**（不用 `...spread`）：messageVersions 在
     *   useThreadStore ↔ turns 的循环里，初始化期取 regenerate / regenQueue 的
     *   导出会 TDZ（真踩过：直接 import 本文件的测试报 '__vite_ssr_import_6__
     *   before initialization'）。放到调用期取，两个绑定都已初始化。
     */
    regenerateMessage: (messageId: string) => {
      /* 排队的重新生成由 turns.finish 放行；注入回去的就是本文件的 regenerateMessage */
      setRegenRunner((id) => get().regenerateMessage(id))
      makeRegenerate(get, (t, q, x, v, r, e) => rerunFrom(t, q, x, v, r, e)).regenerateMessage(
        messageId,
      )
    },
  }
}
