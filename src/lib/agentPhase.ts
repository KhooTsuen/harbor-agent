import type { AgentPhase } from '@/types'

/* ══════════════════════════════════════════════════════════════
   AG-001：Agent 阶段的判定

   状态由主进程的状态机推过来（`phase` 事件），渲染层只读不猜。
   以前 UI 到处写 `thread.status === 'running'` —— 那是旧的一套简化状态，
   和后台真实状态是两条线，随时可能不一致。

   这里集中放「某个阶段意味着什么」，免得判断逻辑散在各组件里。
   ══════════════════════════════════════════════════════════════ */

/** 终态：到了这里这条任务就结束了 */
const TERMINAL: readonly AgentPhase[] = ['completed', 'failed', 'cancelled']

/** 空闲：还没开始 */
const IDLE: readonly AgentPhase[] = ['idle']

/**
 * 这个阶段算「正在干活」吗？
 *
 * 用来决定：显示「发送」还是「停止」、要不要禁用输入、状态栏转不转圈。
 * `undefined` 当成空闲 —— 老对话没这个字段，加载中也可能还没收到事件。
 */
export function isActivePhase(phase?: AgentPhase): boolean {
  if (!phase) return false
  return !IDLE.includes(phase) && !TERMINAL.includes(phase)
}

/** 阶段是不是已经结束了（三种结束方式之一） */
export function isTerminalPhase(phase?: AgentPhase): boolean {
  return !!phase && TERMINAL.includes(phase)
}

/**
 * 阶段 → 给用户看的一句话。
 *
 * AG-008 要求的「消除无意义等待」：不要一直显示 Thinking…，
 * 要说清现在到底在干什么。
 */
const LABELS: Partial<Record<AgentPhase, string>> = {
  preparing: '正在准备任务',
  thinking: '正在分析任务',
  planning: '正在制定计划',
  executing: '正在执行',
  verifying: '正在验证结果',
  responding: '正在整理回答',
  waiting_user: '等待你确认',
  paused: '已暂停',
  retrying: '正在重试',
}

export function phaseLabel(phase?: AgentPhase): string {
  if (!phase) return ''
  return LABELS[phase] ?? ''
}
