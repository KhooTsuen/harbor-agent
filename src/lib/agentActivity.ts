import type { AgentPhase, ToolRunRecord } from '@/types'
import { phaseLabel } from './agentPhase'

/* ══════════════════════════════════════════════════════════════
   「现在到底在干什么」（AG-008）

   要消掉的是这种：

     Thinking...
     Thinking...
     Thinking...

   换成真的在发生的事：

     正在分析任务…        ← 相位（还没开始调工具）
     正在读取 cmd/main.gd  ← 正在跑的工具 + 它的参数
     正在运行 npm test
     正在搜索 胡斯战争

   数据全是现成的：相位来自主进程状态机（AG-001），
   正在跑的工具来自 `agent.tool.started` 推来的 running 记录。
   这里只做一件事 —— **选一个最具体的说法**：
   有工具在跑就说工具，没有才退回相位。

   ★ 有意不做「正在修改 3 个文件…」这种计数：
     一是「连续同名才算一批」在真实调用里不常见，
     二是**参数名比个数有用**（「正在修改 main.ts」远胜过「正在修改第 3 个文件」）。
     文档里那行是示意，不是硬性格式。
   ══════════════════════════════════════════════════════════════ */

/**
 * 工具名 → [动作词, 量词]。
 *
 * 量词是给分组计数用的（「读取 5 个文件」，AG-006），
 * 动作词是给这里做进行时用的（「正在读取 main.ts」）。
 */
export const AGENT_ACTIONS: Record<string, [string, string]> = {
  read_file: ['读取', '个文件'],
  write_file: ['写入', '个文件'],
  edit_file: ['修改', '个文件'],
  list_dir: ['查看', '个目录'],
  run_shell: ['运行', '条命令'],
  search_web: ['搜索', '次'],
  remember: ['记录', '条记忆'],
  browse: ['打开', '个网页'],
  browse_elements: ['读取页面', '次'],
  browse_click: ['点击', '次'],
  browse_type: ['输入文字', '次'],
  generate_image: ['生成', '张图片'],
}

/** 工具名的动作词；没收录的老实用原名（不编） */
export function verbOf(name: string): string {
  return AGENT_ACTIONS[name]?.[0] ?? name
}

/**
 * 正在跑的那条工具记录。
 *
 * 判据和 ToolRuns.tsx 一致：**还没有 result 也没有耗时**就是还在跑 ——
 * `agent.tool.started` 先插一条空的，`completed` 才补上 output/ms。
 */
export function runningOf(runs: readonly ToolRunRecord[]): ToolRunRecord | undefined {
  return runs.find((run) => run.output === '' && run.ms === undefined)
}

/**
 * 一句话说清现在在干什么。
 *
 * 优先说**最具体**的：正在跑的工具（带参数）> 相位文案 > 兜底。
 */
export function activityLabel(runs: readonly ToolRunRecord[], phase?: AgentPhase): string {
  const running = runningOf(runs)
  if (running) {
    const verb = verbOf(running.name)
    const what = (running.summary ?? '').trim()
    return what ? `正在${verb} ${what}` : `正在${verb}`
  }
  return phaseLabel(phase) || '正在处理…'
}
