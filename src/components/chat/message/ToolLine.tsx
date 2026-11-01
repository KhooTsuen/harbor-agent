import { useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, XCircle } from 'lucide-react'
import type { ToolRunRecord } from '@/types'
import { AGENT_ACTIONS, homogeneousIconOf, runningOf, verbOf, toolLabel } from '@/lib/agentActivity'
import { colorOf } from '@/lib/statusLanguage'
import { useScrollGuard } from '../scrollGuard'
import { formatMs, ToolRunRow } from '../ToolRuns'
import { SubagentCard } from '../SubagentCard'

/* ══════════════════════════════════════════════════════════════
   工具调用**一行说完**（VS Code 那种）

   2026-09-30 用户拿 VS Code 的截图对比后要求的：
     「Checked terminal output and searched for regex patterns」
   一行小字说清干了什么，和正文自然交错 —— 而不是一张带边框的卡片。

   所以这里**不做卡片**（无边框、无背景、无标题行），只给一行摘要 + 可展开的明细。
   这也是**唯一**的工具排版：老的那套带边框的卡片已经拆掉了 ——
   两套并存时同一份对话里新旧消息长得不一样，接缝一眼可见。

   ── AG-038：摊开的上限 ──────────────────────────────────────

   基准测试量出来的：**一万个工具事件展开到底 = 9.4 秒 / 12 万个 DOM 节点**。
   概览行把同类调用归成一类一类（「读取 4 个文件」），但真摊开时还得有上限 ——
   否则一个跑了几千步的任务，用户点一下「展开」就是几秒钟的白屏。

   截的是**最近**的：一长串调用里，最近几步才是当前关心的（和会话列表
   只渲染最近 200 条同一个道理）。超出的部分给一句说明，不假装没有。

   ─────────────────────────────────────────────────────────── */

/** 一次最多摊开多少条调用 */
const MAX_VISIBLE_RUNS = 100

/** 把这一轮的工具捏成一句话：单步说参数，多步按动作归类计数 */
export function describeRuns(runs: readonly ToolRunRecord[]): string {
  if (runs.length === 0) return ''
  if (runs.length === 1) {
    const one = runs[0]
    const arg = String(one.summary ?? '').trim()
    /* 单步：动词 + 对象最有信息量（「读取 README.md」远胜「读取 1 个文件」） */
    if (arg) return `${verbOf(one.name)} ${arg.length > 48 ? `${arg.slice(0, 48)}…` : arg}`
    return toolLabel(one.name)
  }

  /* 多步：同动作合并计数（「读取 2 个文件、运行 1 条命令」），最多列 3 类 */
  const buckets: Array<{ verb: string; unit: string; n: number }> = []
  for (const run of runs) {
    const [verb, unit] = AGENT_ACTIONS[run.name] ?? [run.name, '次']
    const hit = buckets.find((b) => b.verb === verb && b.unit === unit)
    if (hit) hit.n += 1
    else buckets.push({ verb, unit, n: 1 })
  }
  const head = buckets.slice(0, 3).map((b) => `${b.verb} ${b.n} ${b.unit}`)
  const rest = buckets.length - head.length
  return head.join('、') + (rest > 0 ? ` 等 ${buckets.length} 类` : '')
}

export function ToolLine({
  runs,
  hideMeta = false,
}: {
  runs: ToolRunRecord[]
  /**
   * 运行中传 true：**不显示「· N 步」与耗时合计**。
   * 这两个数每来一步就变一次，整行会一直跳 —— 用户明确要「跑的时候不要实时统计」。
   * 展开的明细一条不少，只是不在摘要行上报数。
   */
  hideMeta?: boolean
}) {
  /** 用户点过之后就听用户的（`null` = 还没表态） */
  const [manual, setManual] = useState<boolean | null>(null)
  /*
   * 展开/折叠 = 迁移规则 4（用户自己去动布局）→ FREE，别替他重新滚回去。
   * 和 ThinkBlock 一个规矩。
   */
  const guard = useScrollGuard()
  if (runs.length === 0) return null

  const running = runningOf(runs)
  const failedCount = runs.filter((run) => !run.ok && run.ms !== undefined).length
  /*
   * 有失败且没在跑 → **默认展开明细**：失败发生在哪一步、原因是什么，
   * 不该再藏一层（用户验收表：失败要「显示失败发生在哪一步及真实错误」）。
   * 跑的时候不默认展开 —— 每来一步就重排一次，界面会抖。
   */
  const open = manual ?? (failedCount > 0 && !running)
  const totalMs = runs.reduce((sum, run) => sum + (run.ms ?? 0), 0)
  /*
   * Phase 7 二期：这组工具映射到同一枚图标时才显示（「读取 4 个文件」配文件图标）；
   * 混合类型不给图标 —— 显示一个不准确的类型比没有更糟。颜色仍只表状态。
   */
  const GroupIcon = homogeneousIconOf(runs)
  /* 明细也要有上限（AG-038，理由见文件头） */
  const shown = runs.length > MAX_VISIBLE_RUNS ? runs.slice(-MAX_VISIBLE_RUNS) : runs
  const hidden = runs.length - shown.length

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => {
          setManual(!open)
          guard?.enterFree()
        }}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-2xs text-fg-secondary transition-colors duration-fast hover:text-fg-primary"
      >
        {running ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-accent" />
        ) : failedCount > 0 ? (
          <XCircle size={11} className="shrink-0" style={{ color: colorOf('failed') }} />
        ) : open ? (
          <ChevronDown size={11} className="shrink-0 text-fg-tertiary" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-fg-tertiary" />
        )}
        {GroupIcon ? <GroupIcon size={11} className="shrink-0 text-fg-tertiary" /> : null}
        <span className="min-w-0 truncate">{describeRuns(runs)}</span>
        {/*
          状态文字（图2 验收表）：成功 / 失败 / 进行中**三选一**，右侧固定位置。
          以前只有颜色和图标 —— 色弱用户、以及「这条到底成了没有」这件事
          全靠猜。★ 进行中是中性灰，**不提前标成功**（还在跑的那一步可能失败）；
          ★ 成功用状态色，和失败的红色成对，不是「失败才显眼」。
        */}
        <span
          className="shrink-0"
          data-tool-status={running ? 'running' : failedCount > 0 ? 'failed' : 'completed'}
          style={{
            color: running ? undefined : failedCount > 0 ? colorOf('failed') : colorOf('completed'),
          }}
        >
          {running ? '进行中' : failedCount > 0 ? `${failedCount} 项失败` : '成功'}
        </span>
        {/*
          几步、多久 —— VS Code 那行「Completed 58 steps in 8m 23s」就是这个意思。
          一步一步时没必要报数（那一句本身就点了名）。
          ★ 「几个失败」已经并进上面那个状态字里了（写成「2 项失败」），
            这里不再重复报一次 —— 一行里出现两个失败计数最容易看成两条不同的事。
        */}
        {runs.length > 1 && !hideMeta ? (
          <span className="shrink-0 font-mono text-fg-tertiary">· {runs.length} 步</span>
        ) : null}
        {totalMs > 0 && !hideMeta ? (
          <span className="shrink-0 font-mono text-fg-tertiary">· {formatMs(totalMs)}</span>
        ) : null}
      </button>

      {/*
        子代理卡（v1）：**始终显示、不折叠** —— 子代理读到的原文不进父上下文，
        用户在对话里能看到的就只剩这张卡（理由见 SubagentCard 的文件头）。
        `spawn_subagent` 那条记录上没挂 trace 的（老会话 / 别处调）就不渲染。
      */}
      {runs.map((run) =>
        run.subagent ? <SubagentCard key={`sub-${run.id}`} trace={run.subagent} /> : null,
      )}

      {open ? (
        <div
          className="mt-1 flex flex-col gap-1 border-l-2 pl-3"
          style={{ borderColor: 'var(--border-strong)' }}
        >
          {hidden > 0 ? (
            <p className="py-0.5 text-2xs text-fg-tertiary">
              只显示最近 {MAX_VISIBLE_RUNS} 步，更早的 {hidden} 步没摊开（这一步一共 {runs.length}{' '}
              步）
            </p>
          ) : null}
          {shown.map((run) => (
            <ToolRunRow key={run.id} run={run} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
