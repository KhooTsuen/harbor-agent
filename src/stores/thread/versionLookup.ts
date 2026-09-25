import type { Message } from '@/types'
import { useAppStore } from '../useAppStore'
import { useUIStore } from '../useUIStore'

/* ══════════════════════════════════════════════════════════════
   「这一版提问」的找回 / 提示 / 补答 —— 为「切版本不许自动重跑」服务

   背景（真机日志）：切提问版本时应用会**自动重跑一轮生成**，连点四次切换
   = 四次 chat:send；09-25 那次用户点完「上一版」4 秒后又慌忙点了「停止生成」。
   根因见 `findQuestion` 的注释（重读换 id → 按 id 找不到 → 被当成没回答过）。

   现在的规矩：
     · 切版本本身**只换显示**（回答过的那一版重读后自己就在）；
     · 没回答过的那一版**只弹提示**，点「补一版回答」才跑（`offerAnswerVersion`）；
     · 点按钮后的执行**重新按签名找一遍**（`answerVersionRerun`），不存 id。
   ══════════════════════════════════════════════════════════════ */

/**
 * 重读之后按「签名」找回同一条提问。
 *
 * ★ 不能用 `message.id`：`openFromDisk` 重读会给**每条消息换一个新 uid**
 *   （`storedToUi` 里是 `uid('msg')`），重读前拿到的 id 重读后一定找不到 ——
 *   真机日志里每次切版本都会因此多跑一轮模型（查找失败被当成「这一版没回答过」）。
 *   签名用重读不会变的东西：内容 + 版本表；同文两条这种极端情况再用 `timestamp` 消歧。
 *
 * ★ 也不要求 `versionIndex` 已经等于目标版：弹出提示到用户点按钮之间内存可能
 *   还没切过去（重读失败的兜底路径），按「目标那版的文字」匹配即可。
 */
export function findQuestion(
  messages: readonly Message[],
  text: string,
  versions: readonly string[] | undefined,
  index: number,
  ts?: number,
): Message | undefined {
  const same = messages.filter((m) => {
    if (m.role !== 'user') return false
    const mine = m.versions ?? []
    if (!versions || versions.length === 0) return m.content === text
    if (mine.length !== versions.length) return false
    if (!mine.every((v, i) => v === versions[i])) return false
    /* 目标那版的文字：重读过 → content 已经是它；没重读过 → 还在版本表里 */
    return m.content === text || mine[index] === text
  })
  if (same.length <= 1) return same[0]
  return same.find((m) => m.timestamp === ts) ?? same[same.length - 1]
}

/** 「这一版还没有回答过」的提示 + 一键补答按钮（点不点由用户决定；回调由调用方给） */
export function offerAnswerVersion(onConfirm: () => void): void {
  useUIStore
    .getState()
    .showToast('info', '这一版还没有回答过', '点「补一版回答」让 Agent 按这一版答一次', {
      label: '补一版回答',
      onClick: onConfirm,
    })
}

/**
 * 「补一版回答」按钮点下去后的执行：**重新**按签名找回那条提问再跑。
 *
 * ★ 不存 id：从提示弹出到用户点按钮之间，用户可能切过别的会话（重读换 id），
 *   存下来的 id 早就不作数了。找回的提问交给 `rerun`（调用方才够得着 rerunFrom）。
 */
export function answerVersionRerun(
  threadId: string,
  text: string,
  versions: string[] | undefined,
  index: number,
  rerun: (questionId: string) => void,
): void {
  const thread = useAppStore.getState().threads.find((t) => t.id === threadId)
  const question = thread ? findQuestion(thread.messages, text, versions, index) : undefined
  if (question) rerun(question.id)
}

/**
 * 把「这条提问现在显示第几版」写进磁盘（不写：重开会话又跳回最后一版）。
 *
 * ★ **整条替换**（读侧按 key 收敛成一条），每个要留存的字段都得带上，
 *   漏一个就被抹掉。`answerIndexByVersion` 同理。
 */
export function persistVersion(threadId: string, message: Message): void {
  useAppStore.getState().persistMessage(threadId, {
    role: 'user',
    /*
     * ★ 必须写回**磁盘 key**（`diskKey`），不能写重读后的新 uid ——
     * 写新 uid 会为同一个提问追加一条新 key 的记录：重读后变成两个提问副本、
     * 切过去也找不到它那一版的回答（真机探针逮到的）。
     */
    key: message.diskKey ?? message.id,
    content: message.content,
    ts: message.timestamp,
    ...(message.versions ? { versions: message.versions } : {}),
    ...(message.versionIndex !== undefined ? { versionIndex: message.versionIndex } : {}),
    ...(message.answerIndexByVersion ? { answerIndexByVersion: message.answerIndexByVersion } : {}),
  } as never)
}
