import type { TaskRecord } from '@/types/safety'

/* ══════════════════════════════════════════════════════════════
   /harbor 本地统计（设计文档 §13.4）

   数据全部来自**任务台账**（task:list），不上传、不读额外的文件；
   算不出来的项就不显示（调用方按空值隐藏）。

   注意: TEST_HINTS 与内核 `electron/core/task-outcome.cjs` 是同一口径 ——
   「运行测试：N」指的就是内核认的那些测试命令。改动必须两边一起改，
   harborStats.test.ts 会核对两边的内容。
   ══════════════════════════════════════════════════════════════ */

/** 什么算「跑测试」—— 与内核 task-outcome.cjs 的 TEST_HINTS 逐条对应 */
export const TEST_HINTS: RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/i,
  /\b(vitest|jest|pytest|rspec|phpunit|tox|ctest)\b/i,
  /\b(go|cargo|dotnet|mvn|gradle|gradlew)\s+test\b/i,
  /\bmake\s+test\b/i,
  /\b[\w./\\-]*tests?\.(sh|py|mjs|cjs|bat|ps1)\b/i,
]

export function isTestCommand(text: string): boolean {
  return TEST_HINTS.some((pattern) => pattern.test(text))
}

export interface HarborStats {
  completed: number
  /** 中止/放弃的任务 */
  cancelled: number
  /** 恢复过几次（各任务 resumeCount 合计） */
  resumed: number
  /** 跑过的测试命令条数 */
  testRuns: number
  /** 最常用的工具（'' = 台账里没有步骤数据） */
  topTool: string
}

export function aggregateHarborStats(tasks: readonly TaskRecord[]): HarborStats {
  let completed = 0
  let cancelled = 0
  let resumed = 0
  let testRuns = 0
  const toolCount = new Map<string, number>()
  for (const task of tasks) {
    if (task.status === 'completed') completed += 1
    if (task.status === 'cancelled') cancelled += 1
    resumed += task.resumeCount ?? 0
    for (const command of task.commands ?? []) {
      if (isTestCommand(command.command)) testRuns += 1
    }
    for (const step of task.steps ?? []) {
      if (step.tool) toolCount.set(step.tool, (toolCount.get(step.tool) ?? 0) + 1)
    }
  }
  let topTool = ''
  let best = 0
  for (const [tool, count] of toolCount) {
    if (count > best) {
      best = count
      topTool = tool
    }
  }
  return { completed, cancelled, resumed, testRuns, topTool }
}
