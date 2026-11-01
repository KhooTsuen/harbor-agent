/**
 * 任务归属判定：一次运行只做一次（P0-3，2026-10-23）
 *
 * ── 问题 ─────────────────────────────────────────────────────
 *
 * 以前同一个问题被**决定了两次**，而且第二次的决定没有回去改第一次的结论：
 *
 *   ① `handlers/chat-run.cjs` 先按 `payload.taskId` 生成任务提示（taskState）——
 *      此时还不知道这次到底会复用哪条任务。
 *   ② `core/loop-run.cjs` 之后才用 `isContinueIntent` / `activeForSession` /
 *      `openForRun` 决定「复用还是新建」。
 *
 * 于是提示里说「你在做 A」，台账里落的却是 B；`waiting_user` 与 paused 的判据
 * 还各散在两处（`task-resume.cjs` 的 `activeForSession` 与 `loop-run` 的 `attached`）。
 *
 * ── 这里的规则（唯一一处）──────────────────────────────────────
 *
 * 输入本轮的事实，输出一个**结构化结果**，之后谁都不许再自己判：
 *
 *   · `resume`             —— 明确要接着那条任务做，`taskId` 就是要复用的
 *   · `new`                —— 开一条新的
 *   · `needs_clarification` —— 有一条在等用户回话，但这句看不出是不是在回答它。
 *                             P0 阶段**不弹卡、不接回旧台账**（用户明确要求
 *                             「不凭猜测覆盖旧台账」），只把它作为背景告诉模型。
 *
 * 判定顺序（前一条命中就不再往下走）：
 *
 *   1. `resumeTaskId` 非空 → 那条任务还能恢复就是 `resume`（用户点了「继续」）。
 *   2. 同一会话里这句话是明确的「继续」→ 有 paused / waiting_user 就 `resume`。
 *      （`isContinueIntent` 的判据在 `task-steering.cjs`，那条正则只有一处）
 *   3. 有 `waiting_user` 任务但这句话不是「继续」→ `needs_clarification`。
 *      文档口径：「其他说法在 P0 阶段保持保守」。
 *   4. 其余 → `new`。
 *
 * ★ 这里**不写盘、不调模型**：纯判定，`scripts/selftest` 可以直接钉。
 */

const taskCore = require('./task.cjs')
const { isContinueIntent } = require('./task-steering.cjs')

/** 这两种状态都算「停下来了，可以接着做」（与 task-resume.cjs 的 RESUMABLE 同义） */
const RESUMABLE = new Set(['paused', 'waiting_user'])

/**
 * @param {{ resumeTaskId?: string, sessionId?: string, goal?: string,
 *           continueIntent?: boolean | null }} input
 *   `continueIntent` 显式给了就用它（老调用方 / 自带「这是继续」标志的路径），
 *   没给（`null`）才从 `goal` 的措辞里认 —— 认法仍然只有 `task-steering` 那一处正则。
 * @returns {{ kind: 'resume' | 'new' | 'needs_clarification', taskId: string,
 *             backgroundTaskId: string, continueIntent: boolean, reason: string }}
 */
function decide({ resumeTaskId = '', sessionId = '', goal = '', continueIntent = null } = {}) {
  const wantsContinue =
    typeof continueIntent === 'boolean' ? continueIntent : isContinueIntent(goal)
  const none = { taskId: '', backgroundTaskId: '', continueIntent: wantsContinue }

  /* 1. 显式指定 —— 用户点了「继续」或任务中心里选了某条 */
  if (resumeTaskId) {
    const task = safeGet(resumeTaskId)
    if (task && RESUMABLE.has(task.status)) {
      return { ...none, kind: 'resume', taskId: task.id, reason: 'explicit' }
    }
    /* 点了一条已经不能恢复的（已完成 / 被删）→ 新建，但理由要说清 */
    return { ...none, kind: 'new', reason: task ? `explicit-${task.status}` : 'explicit-missing' }
  }

  if (!sessionId) return { ...none, kind: 'new', reason: 'no-session' }

  const tasks = safeList(sessionId)
  const waiting = tasks.find((task) => task.status === 'waiting_user') ?? null
  const paused = tasks.find((task) => task.status === 'paused') ?? null

  /* 2. 明确说「继续」 */
  if (wantsContinue) {
    const hit = paused ?? waiting
    if (hit && RESUMABLE.has(hit.status)) {
      return { ...none, kind: 'resume', taskId: hit.id, reason: 'continue-intent' }
    }
  }

  /* 3. 有任务在等你回话，但这句不像「继续」→ 不替用户决定它是不是回答 */
  if (waiting) {
    return {
      ...none,
      kind: 'needs_clarification',
      backgroundTaskId: waiting.id,
      reason: 'waiting-user-not-continue',
    }
  }

  /* 4. paused 但没说继续 → 新开一条（旧任务作为背景留在提示里） */
  return { ...none, kind: 'new', reason: paused ? 'paused-no-continue' : 'fresh' }
}

/** 读一条任务；台账读坏了不能把这一轮对话搞挂 */
function safeGet(id) {
  try {
    return taskCore.get(String(id ?? '')) ?? null
  } catch {
    return null
  }
}

/** 本会话未完成任务（按 updatedAt 降序，`list` 已经排好） */
function safeList(sessionId) {
  try {
    return taskCore.list({ limit: 50, sessionId }) ?? []
  } catch {
    return []
  }
}

module.exports = { decide, RESUMABLE }
