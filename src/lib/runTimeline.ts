import type { TaskRecord } from '@/types/safety'
import { toolLabel } from './agentActivity'

/* ══════════════════════════════════════════════════════════════
   Run Inspector 的数据层（AG-048 · 只读）

   一屏看懂一次任务执行 —— 但**先得有「一条按时间排的流水」**。

   三路既有数据合成一条线（全部来自台账 `TaskRecord`，没有任何新 IPC）：

     · `task.steps`       → 工具调用（有 at / tool / ok / ms / summary）
     · `task.errors`      → 出错（at / message）
     · `task.checkpoints` → 检查点（at / label / note）

   ── 三条硬规矩 ──
     1. **缺时间戳不许炸**。台账是从磁盘读的，老记录字段可能没有 / 是坏值；
        实测过 `read_file` 的返回里夹着一段坏 JSON 就能让读它的组件白屏。
        这里一律兜底：没有可信时间 → `atKnown: false`，排到**最后**
        （不知道它什么时候发生，就别硬塞进时间轴中间假装知道）。
     2. **排序必须稳定**。同一毫秒的三条（工具回包 + 检查点常常同刻）
        必须保持「steps → errors → checkpoints」的原始相对顺序，
        否则每次重渲染顺序都可能抖一下，看着像在乱跳。
     3. **不编数据**。摘要为空就空着，工具名认不出就用原名（`toolLabel` 的
        兜底就是返原名），绝不拿「未知」「无」这类词把空位填满。
   ══════════════════════════════════════════════════════════════ */

export type RunTimelineKind = 'step' | 'error' | 'checkpoint'

export interface RunTimelineEntry {
  /** 墙上的时间戳（毫秒）。**不可信时是 0**，看 `atKnown` 决定要不要显示 */
  at: number
  /** false = 原始记录里没有可信时间（缺失 / 非数字 / ≤ 0），界面别显示时间 */
  atKnown: boolean
  kind: RunTimelineKind
  /** 一行的主语：工具名（已转人话）/ 错误首行 / 检查点标签 */
  title: string
  /** 补充说明：工具摘要（带耗时）/ 完整错误 / 检查点备注。可能为空串 */
  detail: string
  /** 这一步是否成功。错误恒为 false；检查点是「发生过」，恒为 true */
  ok: boolean
}

/**
 * 取出可信的时间戳。
 *
 * epoch 毫秒不可能 ≤ 0，所以 0 / 负数 / NaN / 非数字一律当「没有时间」——
 * 这样 `Number(undefined)`（NaN）和 `Number(null)`（0）都会落到同一档，
 * 不需要在调用处再分情况。
 */
function timeOf(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 工具摘要 + 耗时，合成一行（耗时读不出来就不提它，不写 0ms） */
function stepDetail(summary: string, ms: unknown): string {
  const n = typeof ms === 'number' ? ms : Number(ms)
  const took = Number.isFinite(n) && n > 0 ? `${Math.round(n)}ms` : ''
  if (summary && took) return `${summary} · ${took}`
  return summary || took
}

/** 堆栈 / 工具回包动辄一整篇 —— 标题只取第一行，压掉空白并截断 */
function firstLine(value: string, max = 72): string {
  const line = value.split('\n').find((item) => item.trim())
  const flat = (line ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function entryOf(
  at: number | null,
  kind: RunTimelineKind,
  title: string,
  detail: string,
  ok: boolean,
): RunTimelineEntry {
  return { at: at ?? 0, atKnown: at !== null, kind, title, detail, ok }
}

/** 排序键：没有时间的排到最后（用 Infinity，比较时不会和任何真实时间打平） */
function sortKey(entry: RunTimelineEntry): number {
  return entry.atKnown ? entry.at : Number.POSITIVE_INFINITY
}

/**
 * 把三类台账记录合成一条按时间排的流水。
 *
 * 纯函数：不读 store、不碰时钟、不改入参，同样的任务调两次结果逐字节相同。
 */
export function buildRunTimeline(task: TaskRecord): RunTimelineEntry[] {
  const entries: RunTimelineEntry[] = []

  for (const step of task.steps ?? []) {
    entries.push(
      entryOf(
        timeOf(step?.at),
        'step',
        toolLabel(String(step?.tool ?? '')) || '工具调用',
        stepDetail(text(step?.summary), step?.ms),
        /* 只有明确 false 才算失败 —— 老记录缺 ok 时按成功算，别把好事报成坏事 */
        step?.ok !== false,
      ),
    )
  }

  for (const error of task.errors ?? []) {
    const message = text(error?.message)
    entries.push(
      entryOf(timeOf(error?.at), 'error', firstLine(message) || '执行出错', message, false),
    )
  }

  for (const checkpoint of task.checkpoints ?? []) {
    entries.push(
      entryOf(
        timeOf(checkpoint?.at),
        'checkpoint',
        text(checkpoint?.label) || '检查点',
        text(checkpoint?.note),
        true,
      ),
    )
  }

  /* `Array.prototype.sort` 自 ES2019 起是稳定的 —— 打平的条目自动保持上面的拼装顺序 */
  return entries.sort((a, b) => {
    const left = sortKey(a)
    const right = sortKey(b)
    if (left === right) return 0
    return left < right ? -1 : 1
  })
}
