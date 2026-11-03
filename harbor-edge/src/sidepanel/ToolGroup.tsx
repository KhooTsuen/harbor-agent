/**
 * 侧边栏的「一组工具」—— 与主窗口 `chat/message/ToolLine.tsx` **同一个粒度**（2026-11-04）
 *
 * ── 粒度为什么是「一组一行」而不是「一条一行」────────────────────
 *
 * 用户原话：「工具颗粒度，整组一行，与 Harbor agent 一致」。
 * 主窗口里一轮对话的工具是**捏成一行**的（「读取 4 个文件、运行 2 条命令 · 6 步 · 3.1s」），
 * 点开才摊明细；侧边栏以前是**每条工具一行**，跑 20 步就是 20 行小字，
 * 把 400px 的面板挤满 —— 同一段对话在两处看起来是两回事，这正是「分裂感」。
 *
 * ── 复用什么、为什么只能复用一半 ────────────────────────────────
 *
 * **复用**（都是纯数据 / 纯映射，两边必须同一份，硬约束 #9）：
 *   · `@/lib/agentActivity` —— 动作词与量词（`AGENT_ACTIONS`）、`verbOf`、`toolLabel`、
 *     `homogeneousIconOf`（同类型才给图标，混合不给）；
 *   · `@/lib/statusLanguage` —— `colorOf('failed' | 'completed')`（状态色只有一处定义）；
 *   · `@/components/chat/ToolRuns` 的 `formatMs` —— 毫秒说成人话。
 *
 * **不能复用**：主窗口的 `ToolLine` / `describeRuns` / `ToolRunRow` 都要
 * `ToolRunRecord`（`id` + `output` 必填，还要 `progress` / `subagent`），而侧边栏这边
 * 是内核瘦身后的 `{name, ok, ms, summary, output}`。硬套要么类型报错，要么渲染出一堆
 * 空摘要 —— 所以下面那句**摘要怎么拼**是照同一口径重写的（48 字截断、按动作分桶、
 * 最多列 3 类），行为与 `describeRuns` 一致，但吃的是侧边栏这份形状。
 * 「两处类名 / 这段拼句各写一遍」是本任务接受的临时例外（要抽公共件得改主窗口，
 * 那不在本次范围内）—— 已记进已知遗留。
 *
 * ⚠️ 展开后视图会贴一次底（主窗口是保持不动的）：`AutoscrollBox` 目前不消费
 *    `ScrollGuardContext`，所以点开明细时没有「用户自己动的布局」这个信号。
 *    明细通常只有几行（内核最多带 30 条），影响是「往下推一点」，不是跳走 ——
 *    真机上觉得碍事再给它接上，别在这里另造一套滚动逻辑。
 */

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, XCircle } from 'lucide-react'
import type { ToolRunRecord } from '@/types'
import { AGENT_ACTIONS, homogeneousIconOf, toolLabel, verbOf } from '@/lib/agentActivity'
import { colorOf } from '@/lib/statusLanguage'
import { formatMs } from '@/components/chat/ToolRuns'
import { normalizeToolRuns, type SideToolRun } from './mergeMessages'

/**
 * 侧边栏那份 → 主窗口的 `ToolRunRecord`（**只补齐、不改名**）。
 *
 * 为什么要升格成主窗口那个形状：`homogeneousIconOf` 吃的是 `ToolRunRecord[]`，
 * 而侧边栏的记录没有 `id`（内核只给 key 用的序号）也没有稳定的 `output`
 * （成功的那条内核故意不带，省字节）。与其在这里重写一份「哪些工具同一类图标」，
 * 不如把这两个字段补成主窗口语义里的中性值（`id` 只作 key、`output: ''` 就是
 * 「没有输出」），然后**用同一份判别**——这正是硬约束 #9 要的。
 *
 * ★ 2026-11-04：导出给 `SideActions.tsx` 用（「复制完整记录」要把工具记录交给
 *   `fullRecordText`，那边吃的正是 `ToolRunRecord[]`）。同一个形状翻译只留这一份。
 */
export function asRunRecords(runs: readonly SideToolRun[]): ToolRunRecord[] {
  return runs.map((run, i) => ({
    id: `side-${i}`,
    name: run.name,
    ok: run.ok,
    output: run.output ?? '',
    ...(run.ms !== undefined ? { ms: run.ms } : {}),
    ...(run.summary ? { summary: run.summary } : {}),
  }))
}

/** 摘要里单条参数最多显示多少字（与主窗口 `describeRuns` 同一个数） */
const MAX_ARG = 48

/** 最多列几类动作（再多就说「等 N 类」） */
const MAX_KINDS = 3

/**
 * 这一组工具捏成一句话。
 *
 * 单条：动词 + 参数（「读取 README.md」远胜「读取 1 个文件」）；
 * 多条：同动作合并计数（「读取 3 个文件、运行 2 条命令」）。
 *
 * 口径与主窗口 `ToolLine.tsx` 的 `describeRuns` 逐条对应 —— 改那边的话这里要跟。
 */
export function describeTools(runs: readonly SideToolRun[]): string {
  if (runs.length === 0) return ''
  if (runs.length === 1) {
    const one = runs[0]
    const arg = String(one.summary ?? '').trim()
    if (arg)
      return `${verbOf(one.name)} ${arg.length > MAX_ARG ? `${arg.slice(0, MAX_ARG)}…` : arg}`
    return toolLabel(one.name)
  }
  const buckets: Array<{ verb: string; unit: string; n: number }> = []
  for (const run of runs) {
    const [verb, unit] = AGENT_ACTIONS[run.name] ?? [run.name, '次']
    const hit = buckets.find((b) => b.verb === verb && b.unit === unit)
    if (hit) hit.n += 1
    else buckets.push({ verb, unit, n: 1 })
  }
  const head = buckets.slice(0, MAX_KINDS).map((b) => `${b.verb} ${b.n} ${b.unit}`)
  const rest = buckets.length - head.length
  return head.join('、') + (rest > 0 ? ` 等 ${buckets.length} 类` : '')
}

/** 展开后的一条明细（一行说完；失败的那条把原因摊在下面 —— 与主窗口同一个规矩） */
function DetailRow({ run }: { run: SideToolRun }) {
  return (
    <div className="text-2xs">
      <div className="flex items-baseline gap-1.5">
        <span className={`shrink-0 ${run.ok ? 'text-fg-secondary' : 'text-danger'}`}>
          {run.name}
        </span>
        {run.summary ? (
          <span className="min-w-0 truncate text-fg-tertiary" title={run.summary}>
            {run.summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {run.ms && run.ms > 0 ? (
          <span className="shrink-0 font-mono text-fg-tertiary">{formatMs(run.ms)}</span>
        ) : null}
        <span className="shrink-0" style={{ color: colorOf(run.ok ? 'completed' : 'failed') }}>
          {run.ok ? '成功' : '失败'}
        </span>
      </div>
      {!run.ok && run.output ? (
        /*
         * ★ 颜色走 `colorOf('failed')`，不手写 `var(--text-danger)` ——
         *   那个变量**根本不存在**（真机探针读回的计算色是正文白，不是红），
         *   写错不会报错、只是不生效。状态色的唯一真相源是 `lib/statusLanguage`。
         */
        <p
          className="mt-0.5 whitespace-pre-wrap break-words text-2xs"
          style={{ color: colorOf('failed') }}
        >
          {run.output}
        </p>
      ) : null}
    </div>
  )
}

/**
 * 一组工具：一行摘要 + 可展开的明细。
 *
 * @param props.runs 内核瘦身后的工具记录（形状见 `SideToolRun`）
 */
export function ToolGroup({ runs: raw }: { runs: readonly SideToolRun[] }) {
  /* 外部数据（磁盘 → 主进程 → 这里）过一遍：别让缺字段的记录把失败画成成功 */
  const runs = useMemo(() => normalizeToolRuns(raw), [raw])
  const records = useMemo(() => asRunRecords(runs), [runs])
  /** 用户点过之后就听用户的（`null` = 还没表态） */
  const [manual, setManual] = useState<boolean | null>(null)
  if (runs.length === 0) return null

  const failed = runs.filter((run) => !run.ok).length
  /*
   * 有失败 → **默认展开**：失败发生在哪一步、原因是什么，不该再藏一层
   * （与主窗口 `ToolLine` 同一条规矩）。侧边栏拿到的都是终态记录，没有「跑的时候别展开」那半条。
   */
  const open = manual ?? failed > 0
  const totalMs = runs.reduce((sum, run) => sum + (run.ms ?? 0), 0)
  /* 只有整组映射到同一枚图标才给图标（混合类型给一个不准确的类型比没有更糟） */
  const GroupIcon = homogeneousIconOf(records)

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-2xs text-fg-secondary transition-colors duration-fast hover:text-fg-primary"
      >
        {failed > 0 ? (
          <XCircle size={11} className="shrink-0" style={{ color: colorOf('failed') }} />
        ) : open ? (
          <ChevronDown size={11} className="shrink-0 text-fg-tertiary" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-fg-tertiary" />
        )}
        {GroupIcon ? <GroupIcon size={11} className="shrink-0 text-fg-tertiary" /> : null}
        <span className="min-w-0 truncate">{describeTools(runs)}</span>
        {/* 状态文字三选一里侧边栏只有两种（记录都是终态）：失败报数、否则成功 */}
        <span
          className="shrink-0"
          data-tool-status={failed > 0 ? 'failed' : 'completed'}
          style={{ color: colorOf(failed > 0 ? 'failed' : 'completed') }}
        >
          {failed > 0 ? `${failed} 项失败` : '成功'}
        </span>
        {runs.length > 1 ? (
          <span className="shrink-0 font-mono text-fg-tertiary">· {runs.length} 步</span>
        ) : null}
        {/*
          用时：先前是裸的 `1.2s`（只有数字，没有「用时」两个字）。
          ★ 2026-11-04 用户拍板「两样都放」：入口要能同时看到
            「读取 3 个文件 · 成功 · 4 步 · 用时 1.2 秒」——
            秒数前面那两个字的代价是单行更挤，400px 下摘要过长时中间那段会
            `truncate`（时间与状态 `shrink-0` 不会被吃掉）。
        */}
        {totalMs > 0 ? (
          <span className="shrink-0 font-mono text-fg-tertiary">· 用时 {formatMs(totalMs)}</span>
        ) : null}
      </button>

      {open ? (
        <div
          className="mt-1 flex flex-col gap-1 border-l-2 pl-2"
          style={{ borderColor: 'var(--border-strong)' }}
        >
          {runs.map((run, i) => (
            <DetailRow key={`${run.name}-${i}`} run={run} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
