import type { Message } from '@/types'
import { getActiveThread, useAppStore } from '../useAppStore'
import { useUIStore } from '../useUIStore'
import { stopActiveRequest } from './turns'
import { bumpRegenStreak, queueRegen, REGEN_STREAK_LIMIT } from './regenQueue'

/* ══════════════════════════════════════════════════════════════
   重新生成 / 重试（从 messageVersions.ts 搬出来的 —— 那边 300 行贴上限了）

   与「编辑」共用同一条重跑通道（rerunFrom）：**不新增提问**，把这条回答
   换成同一次提问的又一个回答（界面 ‹ n / N › 切，旧回答保留）。

   Agent 场景比纯聊天多三件事，都在这里处理：

   ① 旧生成还在流式 → **先中止再重来**：
      abort 旧请求 → 排队 → turns.finish()（旧轮真正收尾）后自动开跑。
      旧轮已产出的部分由中止事件标成 interrupted（界面按钮说「重试」），
      落盘标 aborted，重开会话也认得出。
   ② 连续重来超过 5 次 → 提示「换个方向或调整 prompt」（计数见 regenQueue）。
   ③ 给主进程带上 `regenerateOf`（被替代那条回答的**磁盘 key**）：
      主进程据此挂任务台账 `regeneratedFrom`、给旧改动事务盖「被替代」标记
      ——旧副作用因此与新一轮隔离（本轮改动是独立事务，旧事务可手动回滚）。
   ══════════════════════════════════════════════════════════════ */

/** 传给 rerunFrom 的附加信息（原样流到 runElectronTurn → chat:send） */
export interface RegenExtra {
  regeneratedFrom: string
  regenerateIsLast: boolean
}

type Getter = () => { sendingThreads: string[] }
type Rerun = (
  threadId: string,
  questionId: string,
  text: string,
  seedVersion: number | undefined,
  reason: string,
  extra: RegenExtra,
) => void

export function makeRegenerate(
  get: Getter,
  rerun: Rerun,
): {
  regenerateMessage: (messageId: string) => void
} {
  /** 这条回答后面还有没有别的对话轮（只有没有，「旧台账属于它」才一定成立） */
  const isLastTurn = (messages: Message[], index: number): boolean =>
    !messages.slice(index + 1).some((m) => m.role === 'assistant' || m.role === 'user')

  return {
    regenerateMessage: (messageId: string) => {
      const app = useAppStore.getState()
      const ui = useUIStore.getState()
      const thread = getActiveThread(app)
      if (!thread) return
      const index = thread.messages.findIndex((m) => m.id === messageId)
      if (index < 0) return
      const answer = thread.messages[index]
      if (!answer || answer.role !== 'assistant') return

      /* 这条回答是哪次提问产生的：它前面最近的一条用户消息（同「编辑」那条路） */
      let text = ''
      let question: Message | undefined
      for (let i = index - 1; i >= 0; i -= 1) {
        const m = thread.messages[i]
        if (m && m.role === 'user') {
          text = m.content
          question = m
          break
        }
      }
      if (!text || !question) return

      /* ── ① 旧生成还在跑：先中止，排到它真正收尾后再开跑 ── */
      if (get().sendingThreads.includes(thread.id)) {
        stopActiveRequest(thread.id)
        queueRegen(thread.id, messageId)
        ui.showToast('info', '先停掉当前这轮', '它收尾之后马上重新生成这一条（旧内容会保留）')
        return
      }

      /* ── ② 连着重来太多次：劝一句（计数按「提问」算） ── */
      const times = bumpRegenStreak(question.id)
      if (times > REGEN_STREAK_LIMIT) {
        ui.showToast(
          'warning',
          `已经连续重新生成 ${times} 次`,
          '要不要换个方向，或者把 prompt 调整得更具体一点？',
        )
      }

      /* ── ③ 被中止 / 出错的回答 = 「重试」；给主进程带上磁盘 key 作关联 ── */
      const retry =
        answer.interrupted === true || answer.status === 'error' || answer.kind === 'error'
      rerun(thread.id, question.id, text, question.versionIndex ?? 0, retry ? '重试' : '重新生成', {
        /* ★ 用磁盘 key（重读会给内存 id 换新 uid，写盘/对账都要稳定的那个） */
        regeneratedFrom: answer.diskKey ?? answer.id,
        regenerateIsLast: isLastTurn(thread.messages, index),
      })
    },
  }
}
