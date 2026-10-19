import { abortChat, pauseChat } from '@/lib/backend'
import { useThreadStore } from '../useThreadStore'
import { useAppStore } from '../useAppStore'
import { useUIStore } from '../useUIStore'
import { abortMockTurn } from './mockTurn'
import { clearPermissionForThread } from './confirmEvents'
import { queuedMessage } from './messageDraft'

/* ══════════════════════════════════════════════════════════════
   「在跑的那几个请求」：登记 · 停止 · 暂停 · 跑完接着发排队

   从 `turns.ts` 抽出来的 —— 那边贴着 300 行红线，而这一组是**自成一体**的：
   turns.ts 只负责「跑一轮」，这只管「这一轮现在算什么状态」。

   ★ 按**对话**存 id（不是一个全局变量）：并行跑两条对话时，第二条会把第一条的 id
     覆盖掉，于是「停止」永远只能停最后开始的那条（这是一个真踩过的坑）。
   ══════════════════════════════════════════════════════════════ */

/** 正在进行的真实请求：threadId → requestId */
const activeRequests = new Map<string, string>()
const turnWaiters = new Map<string, { promise: Promise<void>; resolve: () => void }>()

/*
 * A3（Phase 5）：每轮对话的「兜底时钟」收尾器。
 *
 * 看门狗是 `runElectronTurn` 闭包里的局部量，原本只有 `finish()` 能 dispose 它。
 * 终态事件到来时由 `finish()` 拆掉它；停止请求本身不提前清理，避免实际取消失败后
 * 这一轮失去兜底收尾。
 */
const activeWatchdogs = new Map<string, () => void>()

/** 这一轮开始时登记它的兜底时钟（`runElectronTurn` 调） */
export function registerTurnWatchdog(threadId: string, dispose: () => void): void {
  activeWatchdogs.set(threadId, dispose)
}

/** 拆掉这条对话的兜底时钟（终态收尾调；幂等，没登记就算了） */
export function disposeTurnWatchdog(threadId: string): void {
  const dispose = activeWatchdogs.get(threadId)
  if (!dispose) return
  dispose()
  activeWatchdogs.delete(threadId)
}

/** 这一轮开始了（`runElectronTurn` 里登记） */
export function beginTurnRequest(threadId: string, requestId: string): void {
  activeRequests.set(threadId, requestId)
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  turnWaiters.set(threadId, { promise, resolve })
}

/** 这一轮结束了 —— 收尾与「发送中止」都要调，别让它一直挂在那儿 */
export function endTurnRequest(threadId: string): void {
  /*
   * 这一轮结束了（done / aborted / error / 看门狗超时都走它）—— 它上面挂着的
   * 权限卡也就作废了：主进程在 finally 里已经 `closeOut(requestId)` 按拒绝结算，
   * 界面只是还没跟上（它永远等不到下一次点击）。不收的话僵尸卡会一直挂在输入框
   * 上方，而 `pickAboveInput` 永远让权限优先 —— 后面**所有澄清卡都被它挡住**
   * （2026-10-07 真机复现，见 confirmEvents.clearPermissionForThread）。
   */
  clearPermissionForThread(threadId)
  activeRequests.delete(threadId)
  turnWaiters.get(threadId)?.resolve()
  turnWaiters.delete(threadId)
}

/** 立即发送必须等旧一轮真正收到终态，避免两个 Agent 同时改同一目录。 */
export async function waitForTurnEnd(threadId: string, timeoutMs = 10_000): Promise<boolean> {
  const waiter = turnWaiters.get(threadId)
  if (!waiter) return !activeRequests.has(threadId)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void waiter.promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
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
  const before = useAppStore.getState().threads.find((thread) => thread.id === threadId)
  if (!before) return
  const next = queuedMessage(list[0])
  sendMessage(next.text, undefined, threadId, next)
  const after = useAppStore.getState().threads.find((thread) => thread.id === threadId)
  if (
    after?.messages.some(
      (message) => message.role === 'user' && !before.messages.some((old) => old.id === message.id),
    )
  )
    removeQueuedMessage(threadId, 0)
}

/** 传 threadId 只停那一条；不传就把所有在跑的都停掉 */
export async function stopActiveRequest(threadId?: string): Promise<boolean> {
  /*
   * 停了这条对话，它上面挂着的澄清卡也就没意义了（2026-10-04，小尾巴 #4）：
   * 留着它的话，用户一按「停止」卡还在问，而主进程那边其实已经在等一个不会来的答案 ——
   * 等到超时就被当成「用户离场」，按默认选项自己开工。所以要**收卡 + 回话**。
   *
   * 只收这一条对话的（`open.threadId`）：后台别的对话的卡不归这次停止管。
   */
  const open = useUIStore.getState().clarify
  if (open && (threadId === undefined || open.threadId === threadId)) {
    useUIStore.getState().cancelClarify()
  }
  /* 权限卡同理：停了这条对话，它上面的写操作确认也作废 —— 收卡 + 回话拒绝，
     别让主进程干等到 5 分钟超时（2026-10-07 补：以前只收澄清卡，权限卡会变僵尸） */
  const perm = useUIStore.getState().permission
  if (perm && (threadId === undefined || perm.threadId === threadId)) {
    useUIStore.getState().cancelPermission()
  }

  let stopped = true
  if (threadId) {
    const id = activeRequests.get(threadId)
    if (id) stopped = await abortChat(id)
  } else {
    const ids = [...activeRequests.entries()]
    const results = await Promise.all(ids.map(([, id]) => abortChat(id)))
    stopped = results.every(Boolean)
  }
  abortMockTurn()
  return stopped
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
