import {
  Bot,
  Brain,
  Check,
  Download,
  FilePen,
  FileText,
  FolderTree,
  Globe,
  HelpCircle,
  Image,
  Search,
  Terminal,
  type LucideIcon,
} from 'lucide-react'
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
  read_image: ['识别', '张图片'],
  write_file: ['写入', '个文件'],
  edit_file: ['修改', '个文件'],
  list_dir: ['查看', '个目录'],
  run_shell: ['运行', '条命令'],
  /* 项目自定义测试（3A）：跑用户为某个项目配好的测试 —— 与「运行命令」区分开 */
  run_project_test: ['跑项目测试', '次'],
  /* 3B-1 / 3B-2 / 3B-3：分析失败 → 按分析改一处 → 退回那次修改 */
  analyze_test_failure: ['分析测试失败', '次'],
  apply_test_fix: ['按分析修代码', '次'],
  restore_test_fix: ['退回修复', '次'],
  search_web: ['搜索', '次'],
  remember: ['记录', '条记忆'],
  browse: ['打开', '个网页'],
  browse_elements: ['读取页面', '次'],
  browse_click: ['点击', '次'],
  browse_type: ['输入文字', '次'],
  /* AI 用浏览器历史后退/前进（不开新标签）—— 1.28.0 新增 */
  browse_nav: ['网页后退/前进', '次'],
  /* 读无障碍树（页面自己声明的语义）—— 2026-10-09 新增 */
  browse_ax: ['读取无障碍树', '次'],
  generate_image: ['生成', '张图片'],
  /* 真机反馈 9b 的新工具：动作词是「下载」，量词用「个文件」 */
  download: ['下载', '个文件'],
  ask_user: ['询问', '个问题'],
  /* 子代理 v0（1.30.0-beta.4）：派一个只读侦察兵去读文件、带回结论 */
  spawn_subagent: ['派子代理', '次'],
  /* 打卡（2026-10-13）：模型显式声明计划某一步做完 —— 动作词「打卡」 */
  mark_step_done: ['打卡', '步'],
  /* 记忆分层改造阶段 1（2026-10-13）：模型按关键词读长期记忆（只读工具） */
  memory_search: ['搜索记忆', '次'],
  /*
   * Edge 工具族（2026-10-16）：操作**用户自己的 Edge**（与 `browse_*` 的内嵌
   * 浏览器区分开）—— 动作词带「Edge」，让时间线上一眼看出动的是哪个浏览器。
   */
  edge_page: ['打开', '个 Edge 页面'],
  edge_click: ['点击 Edge 元素', '次'],
  edge_type: ['填写 Edge 输入', '次'],
  edge_select: ['选择 Edge 下拉项', '次'],
  edge_scroll: ['滚动 Edge 页面', '次'],
  edge_wait: ['等待 Edge 条件', '次'],
  edge_key: ['向 Edge 按键', '次'],
  edge_focus: ['聚焦 Edge 元素', '次'],
  edge_tabs: ['操作 Edge 标签页', '次'],
}

/** 工具名的动作词；没收录的老实用原名（不编） */
export function verbOf(name: string): string {
  return AGENT_ACTIONS[name]?.[0] ?? name
}

/**
 * 工具名 → 人话（名词形式）。
 *
 * 时间线的「动作行」是给人看的，显示 `list_dir` 等于没显示（AG-005 留下的已知问题）。
 * 和 `AGENT_ACTIONS` 分开是因为**用途不同**：那边是「动词 + 量词」拿来拼句子
 * （「正在读取 main.ts」、「读取 5 个文件」），这边是一个能独立站住的名词短语。
 */
export const TOOL_LABELS: Record<string, string> = {
  read_file: '读取文件',
  read_image: '读取图片',
  write_file: '写入文件',
  edit_file: '修改文件',
  list_dir: '查看目录',
  run_shell: '运行命令',
  run_project_test: '跑项目测试',
  analyze_test_failure: '分析测试失败',
  apply_test_fix: '按分析修代码',
  restore_test_fix: '退回修复',
  search_web: '联网搜索',
  remember: '记入长期记忆',
  browse: '打开网页',
  browse_elements: '读取页面元素',
  browse_click: '点击页面元素',
  browse_type: '填写页面输入',
  browse_nav: '网页后退/前进',
  browse_ax: '读取无障碍树',
  generate_image: '生成图片',
  download: '下载文件',
  /* AG-053：开工前澄清 —— 界面上是「问你几个问题」，不是「ask_user」 */
  ask_user: '问你几个问题',
  /* 子代理 v0：界面上说「派只读子代理」，不说 spawn_subagent */
  spawn_subagent: '派只读子代理',
  /* 打卡（2026-10-13）：把计划某一步标记为完成 */
  mark_step_done: '完成一步',
  /* 记忆分层改造阶段 1（2026-10-13）：模型搜长期记忆取回完整内容 */
  memory_search: '搜索长期记忆',
  /* Edge 工具族（2026-10-16）：操作**用户自己的 Edge**，与 browse_* 的内嵌浏览器分开 */
  edge_page: '打开 Edge 页面',
  edge_click: '点击 Edge 元素',
  edge_type: '填写 Edge 输入',
  edge_select: '选择 Edge 下拉项',
  edge_scroll: '滚动 Edge 页面',
  edge_wait: '等待 Edge 条件',
  edge_key: 'Edge 按键',
  edge_focus: '聚焦 Edge 元素',
  edge_tabs: '操作 Edge 标签页',
}

/** 工具名的人话；没收录的返回原名（不编） */
export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}

/** 认不出工具时的兜底图标（Phase 7 二期：类型靠图标区分，没收录也不空着） */
const FALLBACK_ICON: LucideIcon = Terminal

/**
 * 工具名 → 图标（Phase 7 二期）。
 *
 * ★ **只管类型，不管状态**：图标表达「这是哪种工具」，成功 / 失败 / 进行中
 *   仍由 `colorOf(status)` 的颜色表达（颜色只有 `statusLanguage.ts` 能定）。
 *   别在这里给不同工具上不同颜色 —— 那会和状态语义色打架。
 *
 * 用**现有** lucide 图标，不引新依赖。同族工具共用一枚（`browse*` 一律 Globe）。
 * 键集合与 `TOOL_LABELS` / `AGENT_ACTIONS` 保持一致（有测试盯着）。
 */
export const TOOL_ICONS: Record<string, LucideIcon> = {
  read_file: FileText,
  read_image: Image,
  write_file: FilePen,
  edit_file: FilePen,
  list_dir: FolderTree,
  run_shell: Terminal,
  /* 项目测试也用终端图标：它本质就是「在命令行里跑一条用户配好的命令」 */
  run_project_test: Terminal,
  /* 3B-1 分析用 Brain（判断类）；3B-2 修复用 FilePen（会改文件）；回退用 Check */
  analyze_test_failure: Brain,
  apply_test_fix: FilePen,
  restore_test_fix: Check,
  search_web: Search,
  remember: Brain,
  browse: Globe,
  browse_elements: Globe,
  browse_click: Globe,
  browse_type: Globe,
  browse_nav: Globe,
  browse_ax: Globe,
  generate_image: Image,
  download: Download,
  ask_user: HelpCircle,
  spawn_subagent: Bot,
  mark_step_done: Check,
  memory_search: Search,
  /* Edge 工具族（2026-10-16）：同族共用一枚（与 browse* 一样是「浏览」类） */
  edge_page: Globe,
  edge_click: Globe,
  edge_type: Globe,
  edge_select: Globe,
  edge_scroll: Globe,
  edge_wait: Globe,
  edge_key: Globe,
  edge_focus: Globe,
  edge_tabs: Globe,
}

/** 工具名的图标；没收录的退回 `Terminal`（不空着、不抛） */
export function toolIconOf(name: string): LucideIcon {
  return TOOL_ICONS[name] ?? FALLBACK_ICON
}

/**
 * 一组工具的**共同图标** —— 只有当这组工具映射到同一枚图标时才返回它，
 * 否则返回 null（混合类型不给图标，免得显示一个不准确的类型）。
 *
 * 概览行（「读取 4 个文件」）拿它当一个小图标：单类工具时锦上添花，
 * 混合时保持原来的干净样子。
 */
export function homogeneousIconOf(runs: readonly ToolRunRecord[]): LucideIcon | null {
  if (runs.length === 0) return null
  const first = toolIconOf(runs[0].name)
  return runs.every((run) => toolIconOf(run.name) === first) ? first : null
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
