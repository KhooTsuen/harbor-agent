import type { TaskRecord } from '@/types/safety'
import { formatCount, formatTokens } from '@/lib/format'

/* ══════════════════════════════════════════════════════════════
   一行用量（AG-044）

     本任务 12.3k token（入 8.1k / 出 4.2k）

   ── 为什么单独一个小组件 ──
     · `TaskRow.tsx` 已经贴 300 行上限（不动它，挂载点在 TaskConsole 里）；
     · 控制台那一屏是文档定的八项（AG-042），再往 `rows` 里塞一行就成仪表盘了，
       而「入 / 出」是**解释**那个总数的一个括号，不是第九项。

   ── 数据从哪来 ──
     台账里的 `tokens` / `tokensIn` / `tokensOut`（`electron/core/loop-run.cjs`
     每轮结束写一次）。**入 / 出是这次任务的累计**（prompt / completion 分别累加），
     不是最后一轮的 —— 别在界面上写成「本轮」。

   ── 缺数据怎么办 ──
     什么都不编：老任务（AG-044 之前建的）只有总数 → 只显示总数；总数也没有
     （刚开始跑 / 上游不给用量）→ 整行不显示。宁可少一行，不要一行「0 token」。
   ══════════════════════════════════════════════════════════════ */

export function TaskTokenBadge({ task }: { task: TaskRecord }) {
  const input = Number(task.tokensIn) || 0
  const output = Number(task.tokensOut) || 0
  /* 总数优先用台账里那个（老任务只有它）；它没有就拿分项自己加 */
  const total = Number(task.tokens) || input + output
  if (total <= 0) return null

  /* 两个分项都有才显示括号 —— 只有一个的话「入 8.1k / 出 0」会被读成「输出是 0」 */
  const split = input > 0 && output > 0
  return (
    <p
      className="mt-1.5 font-mono text-2xs text-fg-tertiary"
      title={
        split
          ? `本任务 token 合计 ${formatCount(total)}（输入 ${formatCount(input)} · 输出 ${formatCount(output)}）`
          : `本任务 token 合计 ${formatCount(total)}（入 / 出未分开记：老任务或上游没给分项）`
      }
    >
      本任务 {formatTokens(total)} token
      {split ? `（入 ${formatTokens(input)} / 出 ${formatTokens(output)}）` : ''}
    </p>
  )
}
