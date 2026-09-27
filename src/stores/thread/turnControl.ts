import { abortChat, pauseChat } from '@/lib/backend'
import { useThreadStore } from '../useThreadStore'
import { abortMockTurn } from './mockTurn'

/* ══════════════════════════════════════════════════════════════
   「在跑的那几个请求」：登记 · 停止 · 暂停 · 跑完接着发排队

   从 `turns.ts` 抽出来的 —— 那边贴着 300 行红线，而这一组是**自成一体**的：
   turns.ts 只负责「跑一轮」，这只管「这一轮现在算什么状态」。

   ★ 按**对话**存 id（不是一个全局变量）：并行跑两条对话时，第二条会把第一条的 id
     覆盖掉，于是「停止」永远只能停最后开始的那条（这是一个真踩过的坑）。
   ══════════════════════════════════════════════════════════════ */

/** 正在进行的真实请求：threadId → requestId */
const activeRequests = new Map<string, string>()

/** 这一轮开始了（`runElectronTurn` 里登记） */
export function beginTurnRequest(threadId: string, requestId: string): void {
  activeRequests.set(threadId, requestId)
}

/** 这一轮结束了 —— 收尾与「发送中止」都要调，别让它一直挂在那儿 */
export function endTurnRequest(threadId: string): void {
  activeRequests.delete(threadId)
}

/**
 * AG-025：一条对话跑完之后，自动发出排队的下一条。
 *
 * 放在收尾里调用 —— 收尾是「消息结束」的统一出口（done / 超时 / 发送失败都走它），
 * 所以排队消息不管上一轮怎么结束的，都会接着发。
 *
 * 不 await：sendMessage 会同步启动新一轮，剩下的交给新一轮自己的事件流。
 */
export function drainQueued(threadId: string): void {
  const { queuedMessages, removeQueuedMessage, sendMessage } = useThreadStore.getState()
  const list = queuedMessages[threadId]
  if (!list || list.length === 0) return
  const next = list[0]
  removeQueuedMessage(threadId, 0)
  sendMessage(next)
}

/** 传 threadId 只停那一条；不传就把所有在跑的都停掉 */
export function stopActiveRequest(threadId?: string): void {
  if (threadId) {
    const id = activeRequests.get(threadId)
    if (id) void abortChat(id)
    activeRequests.delete(threadId)
  } else {
    for (const id of activeRequests.values()) void abortChat(id)
    activeRequests.clear()
  }
  abortMockTurn()
}

/**
 * 暂停（AG-011）：给主进程发个「安全点停住」的请求。
 *
 * ★ 和 stop 的关键区别：**不删登记** —— 请求还在跑，
 *   只是它会做完手上这一步就自己收尾（界面会收到 agent.paused）。
 *   删了的话用户就没法再暂停/停止它了。
 */
export function pauseActiveRequest(threadId?: string): void {
  if (threadId) {
    const id = activeRequests.get(threadId)
    if (id) void pauseChat(id)
    return
  }
  for (const id of activeRequests.values()) void pauseChat(id)
}

/** 按对话记的「正在跑」—— 对应 useThreadStore.sendingThreads */
export interface ThreadPartial {
  sendingThreads?: string[]
}

export interface TurnSetter {
  (partial: ThreadPartial | ((state: { sendingThreads: string[] }) => ThreadPartial)): void
}
