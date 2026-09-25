import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDot,
  Clock3,
  PauseCircle,
  RefreshCw,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import type { AgentPhase, ToastKind } from '@/types'
import type { TaskRecord } from '@/types/safety'

/* ══════════════════════════════════════════════════════════════
   状态视觉语言（AG-031）

   文档要求：Running / Completed / Warning / Failed / Paused / Retrying /
   Waiting / Cancelled 这八种语义，**所有页面用同一套**。

   以前的样子：任务行自己有一张颜色表、任务中心另有一张文字表、进度时间线
   和计划卡又各自写 `var(--success)`/`var(--danger)`，措辞也不一致
   （「等待你确认」和「等待中」指的是同一件事）。同一份状态在不同页面
   长得不一样，用户就得重新学一遍。

   规矩（有测试盯着）：
     · **语义色只有这里能写**。组件里出现 `var(--success)` / `var(--danger)` /
       `var(--warning)` 会被 `statusLanguage.test.ts` 判红。
       （`--accent-blue` 例外：它还兼着「选中 / 链接」这类非状态用途。）
     · 想加一种状态，先在这里加一条，再让页面用它。
   ══════════════════════════════════════════════════════════════ */

export type UiStatus =
  | 'running'
  | 'completed'
  | 'warning'
  | 'failed'
  | 'paused'
  | 'retrying'
  | 'waiting'
  | 'cancelled'
  /**
   * 文档那八种之外的中性态：**没在跑**（空闲、纯信息）。
   * 单独列出来是因为「灰」本身也是一种语义，硬塞进 cancelled 会让人误会。
   */
  | 'neutral'

export interface StatusMeta {
  /** 给用户看的词 —— 全应用只有这一份 */
  label: string
  color: string
  icon: LucideIcon
}

const ACCENT = 'var(--accent-blue)'
const SUCCESS = 'var(--success)'
const WARNING = 'var(--warning)'
const DANGER = 'var(--danger)'
const MUTED = 'var(--text-tertiary)'

export const STATUS_META: Record<UiStatus, StatusMeta> = {
  running: { label: '进行中', color: ACCENT, icon: CircleDot },
  completed: { label: '已完成', color: SUCCESS, icon: CheckCircle2 },
  warning: { label: '需要注意', color: WARNING, icon: AlertTriangle },
  failed: { label: '失败', color: DANGER, icon: XCircle },
  /*
   * Primer 主题轮（2026-09-25）按需求 #5 定了任务状态色：
   *   运行中 = 强调蓝 · 已完成 = 绿 · 需确认（waiting）黄 · 失败红
   *   已暂停 = 灰（--text-muted）—— 「停着」不是警告，不再和 warning 共用
   */
  paused: { label: '已暂停', color: MUTED, icon: PauseCircle },
  retrying: { label: '重试中', color: WARNING, icon: RefreshCw },
  waiting: { label: '等待中', color: WARNING, icon: Clock3 },
  cancelled: { label: '已取消', color: MUTED, icon: Ban },
  neutral: { label: '', color: MUTED, icon: CircleDot },
}

/**
 * 需要 **Tailwind 类名** 的地方（不能用 JS 值，比如 `text-[var(--danger)]`）。
 * 同样是这一份，组件别自己拼。
 */
export const STATUS_CLASS: Record<UiStatus, { text: string; border: string; bg: string }> = {
  running: {
    text: 'text-[var(--accent-blue)]',
    border: 'border-[var(--accent-blue)]',
    bg: 'bg-[var(--accent-blue)]',
  },
  completed: {
    text: 'text-[var(--success)]',
    border: 'border-[var(--success)]',
    bg: 'bg-[var(--success)]',
  },
  warning: {
    text: 'text-[var(--warning)]',
    border: 'border-[var(--warning)]',
    bg: 'bg-[var(--warning)]',
  },
  failed: {
    text: 'text-[var(--danger)]',
    border: 'border-[var(--danger)]',
    bg: 'bg-[var(--danger)]',
  },
  paused: {
    text: 'text-[var(--warning)]',
    border: 'border-[var(--warning)]',
    bg: 'bg-[var(--warning)]',
  },
  retrying: {
    text: 'text-[var(--warning)]',
    border: 'border-[var(--warning)]',
    bg: 'bg-[var(--warning)]',
  },
  waiting: {
    text: 'text-[var(--accent-blue)]',
    border: 'border-[var(--accent-blue)]',
    bg: 'bg-[var(--accent-blue)]',
  },
  cancelled: {
    text: 'text-[var(--text-tertiary)]',
    border: 'border-[var(--border-hairline)]',
    bg: 'bg-[var(--text-tertiary)]',
  },
  neutral: {
    text: 'text-[var(--text-tertiary)]',
    border: 'border-[var(--border-hairline)]',
    bg: 'bg-[var(--text-tertiary)]',
  },
}

export function colorOf(status: UiStatus): string {
  return STATUS_META[status].color
}

export function labelOf(status: UiStatus): string {
  return STATUS_META[status].label
}

export function iconOf(status: UiStatus): LucideIcon {
  return STATUS_META[status].icon
}

/** 任务台账的状态 → 语义。（`waiting_user` 就是文档说的 Waiting） */
export function statusOfTask(status: TaskRecord['status']): UiStatus {
  switch (status) {
    case 'running':
      return 'running'
    case 'paused':
      return 'paused'
    case 'waiting_user':
      return 'waiting'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'neutral'
  }
}

/**
 * 生命周期相位 → 语义。
 *
 * 注意区分两件事：
 *   · **语义**（这里）→ 颜色和状态词，全应用一致；
 *   · **描述**（`agentPhase.phaseLabel`）→ 「正在分析任务」这种具体在做什么。
 * 文档 AG-008 要的是描述，AG-031 要的是语义，两者不冲突。
 */
export function statusOfPhase(phase?: AgentPhase): UiStatus {
  switch (phase) {
    case 'preparing':
    case 'thinking':
    case 'planning':
    case 'executing':
    case 'verifying':
    case 'responding':
      return 'running'
    case 'retrying':
      return 'retrying'
    case 'waiting_user':
      return 'waiting'
    case 'paused':
      return 'paused'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      /* idle / 还没收到相位 —— 中性灰 */
      return 'neutral'
  }
}

/** 单步 / 单次工具调用的状态 → 语义（进度时间线、计划卡、工具列表共用） */
export function statusOfStep(state: 'done' | 'current' | 'todo' | 'failed' | 'active'): UiStatus {
  if (state === 'failed') return 'failed'
  if (state === 'done') return 'completed'
  if (state === 'current' || state === 'active') return 'running'
  return 'neutral'
}

/** 工具调用成功与否 → 语义 */
export function statusOfTool(ok: boolean): UiStatus {
  return ok ? 'completed' : 'failed'
}

/** 轻提示的类型 → 语义（AG-032 的操作反馈也走这套色） */
export function statusOfToast(kind: ToastKind): UiStatus {
  if (kind === 'success') return 'completed'
  if (kind === 'error') return 'failed'
  if (kind === 'warning') return 'warning'
  return 'neutral'
}
