export * from './scenes'
export * from './fonts'
import type { ModelOption, ReasoningLevel, ShortcutDef, ThreadMode } from '@/types'

/* ══════════════════════════════════════════════════════════════
   协作模式

   Plan / Goal 有官方文档支撑（/plan 与 /goal 两个 slash command）。
   Pair / Execute 属于需求文档里的划分，官方没有对应命名——
   「执行」取的是「自主跑」的语义，故映射到 high reasoning。
   ══════════════════════════════════════════════════════════════ */

export interface ModeMeta {
  id: ThreadMode
  label: string
  hint: string
  /** 该模式默认用哪档推理 */
  reasoning: ReasoningLevel
}

export const MODES: readonly ModeMeta[] = [
  {
    id: 'plan',
    label: '计划',
    hint: '只分析、给方案，不改任何文件',
    reasoning: 'high',
  },
  {
    id: 'pair',
    label: '标准',
    hint: '边做边解释，改了什么说清楚',
    reasoning: 'high',
  },
  {
    id: 'execute',
    label: '执行',
    hint: '直接做完，少解释多做事',
    reasoning: 'high',
  },
  {
    id: 'goal',
    label: '目标',
    hint: '多轮持续推进，直到目标达成',
    reasoning: 'high',
  },
] as const

export function modeMeta(mode: ThreadMode): ModeMeta {
  const found = MODES.find((m) => m.id === mode)
  /* MODES 覆盖了全部 ThreadMode，这里只是让 TS 满意 */
  return found ?? MODES[0]
}

/* ── 推理等级 ────────────────────────────────────────────────── */

export const REASONING_LABEL: Record<ReasoningLevel, string> = {
  low: '低',
  high: '高',
  max: '最高',
}

export const REASONING_HINT: Record<ReasoningLevel, string> = {
  low: '快，够用就行',
  high: '平衡',
  max: '慢，适合难题',
}

/*
 * AG-031：这里原来有一套 STATUSES（空闲/执行中/完成/失败/等待/已停止 +
 * green/red/amber）—— 和状态语言表重复，已经并过去了（见 lib/statusLanguage.ts）。
 */

/* ── 模型目录 ────────────────────────────────────────────────── */

export const MODELS: readonly ModelOption[] = [
  {
    id: 'demo-standard',
    label: '标准',
    description: '通用模型（仅浏览器预览使用）',
    reasoning: ['low', 'high', 'max'],
  },
  {
    id: 'demo-mini',
    label: '轻量',
    description: '轻量模型（仅浏览器预览使用）',
    reasoning: ['low', 'high'],
  },
  {
    id: 'demo-reasoning',
    label: '强推理',
    description: '推理模型（仅浏览器预览使用）',
    reasoning: ['high', 'max'],
  },
  {
    id: 'local-custom',
    label: '自定义',
    description: '接你自己部署的模型',
    reasoning: ['low', 'high', 'max'],
  },
] as const

/* ── 快捷键 ──────────────────────────────────────────────────── */

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'search', label: '全局搜索', group: '通用', defaultKeys: 'mod+k' },
  { id: 'new-thread', label: '新建线程', group: '通用', defaultKeys: 'mod+n' },
  { id: 'close-thread', label: '关闭当前线程', group: '通用', defaultKeys: 'mod+w' },
  { id: 'settings', label: '打开设置', group: '通用', defaultKeys: 'mod+,' },
  { id: 'send', label: '发送消息', group: '对话', defaultKeys: 'mod+enter' },
  { id: 'toggle-sidebar', label: '折叠侧边栏', group: '布局', defaultKeys: 'mod+b' },
  { id: 'toggle-bottom', label: '切换底部面板', group: '布局', defaultKeys: 'mod+j' },
  {
    id: 'toggle-right',
    label: '切换右侧面板',
    group: '布局',
    defaultKeys: 'mod+shift+j',
  },
  { id: 'diff-tab', label: '打开审查标签', group: '布局', defaultKeys: 'mod+shift+g' },
  { id: 'dismiss', label: '关闭弹窗 / 取消', group: '通用', defaultKeys: 'esc' },
] as const

/* ── 布局尺寸 ────────────────────────────────────────────────── */

export const LAYOUT = {
  sidebar: { default: 260, min: 200, max: 400, collapsed: 48 },
  rightPanel: { default: 380, min: 280, max: 600 },
  topbarHeight: 48,
  statusBarHeight: 28,
  composerMaxHeight: 200,
} as const

/* ── 输入限制 ────────────────────────────────────────────────── */

export const MAX_INPUT_LENGTH = 4000

/* ── 文案 ────────────────────────────────────────────────────── */

export const EMPTY_THREAD_PROMPTS = [
  '读一遍这个仓库，告诉我它的整体结构',
  '帮我给 utils 里的日期函数补几个边界测试',
  '这段 diff 有什么风险？',
  '把 README 里的安装步骤写成脚本',
] as const
