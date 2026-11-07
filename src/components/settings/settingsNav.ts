import {
  BrainCircuit,
  Cpu,
  Database,
  Gauge,
  Info,
  Palette,
  Puzzle,
  Settings2,
  Shield,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  type LucideIcon,
} from 'lucide-react'

/* ══════════════════════════════════════════════════════════════
   设置工作区的导航结构 —— **13 页 / 5 组的唯一真相源**

   ── 为什么单独一个文件 ─────────────────────────────────────────
   `parts.tsx` 已经贴着 300 行红线，而这里只是数据 + 类型。拆开后
   `parts.tsx` 继续 re-export（老的 import 路径一个字都不用改）。

   ── 分组按「用户想干什么」，不按代码模块 ─────────────────────
     · 基础          —— 装完先调的：我是谁、怎么用、长什么样
     · 智能体与模型  —— 谁在干活、怎么干、看什么上下文
     · 能力与安全    —— 它能碰什么、能装什么、花了多少
     · 数据与知识    —— 我的东西在哪、它记住了什么、学到的规矩
     · 系统          —— 版本与更新

   ── 13 页必须全都在导航里能找到 ──────────────────────────────
   所以导航**不做**简洁/详细过滤（那套过滤只留给搜索结果的措辞提示）。
   理由：用户明确要求「13 个页面在导航中都能找到」；把三页藏进
   「详细视图」就等于要他先猜一遍才找得到。
   ══════════════════════════════════════════════════════════════ */

export type SettingsTabId =
  | 'profile'
  | 'general'
  | 'appearance'
  | 'models'
  | 'conversation'
  | 'context'
  | 'access'
  | 'extension'
  | 'usage'
  | 'data'
  | 'memory'
  | 'experience'
  | 'about'

export interface SettingsTabDef {
  id: SettingsTabId
  label: string
  icon: LucideIcon
  /** 分组标题（null = 不分组） */
  group: string | null
  /** 一句话说明这一页管什么 —— 显示在内容区顶部 */
  blurb: string
  /**
   * 只在「详细视图」里默认展开（沿用 P2 #1 的判据）。
   * ★ 只影响搜索结果的措辞提示，**不影响导航可见性**（13 页始终都在）。
   */
  detailedOnly?: boolean
}

export const SETTINGS_NAV: readonly SettingsTabDef[] = [
  /* ── 基础 ── */
  {
    id: 'profile',
    label: '个人资料',
    icon: UserRound,
    group: '基础',
    blurb: '助手怎么称呼你、界面里显示什么头像。',
  },
  {
    id: 'general',
    label: '通用与快捷键',
    icon: Settings2,
    group: '基础',
    blurb: '启动方式、窗口与托盘、键盘快捷键。',
  },
  {
    id: 'appearance',
    label: '外观与通知',
    icon: Palette,
    group: '基础',
    blurb: '配色、字体、字号、动效，以及每一类通知去哪儿。',
  },

  /* ── 智能体与模型 ── */
  {
    id: 'models',
    label: '模型与服务商',
    icon: Cpu,
    group: '智能体与模型',
    blurb: '连哪个服务商、用哪个模型、助手参数怎么调。',
  },
  {
    id: 'conversation',
    label: '对话与任务',
    icon: SlidersHorizontal,
    group: '智能体与模型',
    blurb: '对话怎么进行、场景模板、生图与下载存到哪。',
  },
  {
    id: 'context',
    label: '上下文与项目',
    icon: Database,
    group: '智能体与模型',
    blurb: '默认工作目录、项目说明、这条对话的临时覆盖。',
  },

  /* ── 能力与安全 ── */
  {
    id: 'access',
    label: '权限与安全',
    icon: Shield,
    group: '能力与安全',
    blurb: '它能碰哪些文件、能连哪些地址、命令风险怎么拦。',
    detailedOnly: true,
  },
  {
    id: 'extension',
    label: '工具与扩展',
    icon: Puzzle,
    group: '能力与安全',
    blurb: '技能、MCP 服务器、浏览器插件、定时任务。',
  },
  {
    id: 'usage',
    label: '模型用量',
    icon: Gauge,
    group: '能力与安全',
    blurb: '真实 token 消耗、账户余额、用量闸（预算）。',
  },

  /* ── 数据与知识 ── */
  {
    id: 'data',
    label: '数据与存储',
    icon: Database,
    group: '数据与知识',
    blurb: '数据存哪、备份与恢复、导出、诊断、删除。',
  },
  {
    id: 'memory',
    label: '记忆',
    icon: BrainCircuit,
    group: '数据与知识',
    blurb: '助手记住的关于你的事，以及每条是哪来的。',
    detailedOnly: true,
  },
  {
    id: 'experience',
    label: '经验与规则',
    icon: Sparkles,
    group: '数据与知识',
    blurb: '真跑验证过的做法；候选要你批过才会进提示。',
    detailedOnly: true,
  },

  /* ── 系统 ── */
  {
    id: 'about',
    label: '关于 Harbor',
    icon: Info,
    group: '系统',
    blurb: '版本、更新状态、许可与致谢。',
  },
] as const

/** 分组的显示顺序（顺序即导航从上到下） */
export const SETTINGS_GROUPS = ['基础', '智能体与模型', '能力与安全', '数据与知识', '系统'] as const

/** 全部合法页 id（用于「记住的页失效时回落」） */
export const SETTINGS_IDS = SETTINGS_NAV.map((item) => item.id)

/** 默认落地页 —— 新用户第一次打开设置看到的第一页 */
export const SETTINGS_HOME: SettingsTabId = 'general'

/** 这个 id 是不是真有一页（脏值 / 老版本存的值 → 回落首页） */
export function isSettingsTabId(value: unknown): value is SettingsTabId {
  return typeof value === 'string' && (SETTINGS_IDS as readonly string[]).includes(value)
}
