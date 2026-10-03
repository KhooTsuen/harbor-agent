export * from './scenes'
export * from './fonts'
export * from './design'
export * from './folders'
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

/**
 * 产品名（顶栏、启动页显示用）。
 * 与主进程 `electron/core/config-defaults.cjs` 的 `BRAND.name` 保持一致 ——
 * 渲染层拿不到那个模块，只能镜像一份。
 */
export const BRAND_NAME = 'Harbor'

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
  sidebar: { default: 240, min: 220, max: 320, collapsed: 48 },
  rightPanel: { default: 360, min: 320, max: 480 },
  topbarHeight: 40,
  statusBarHeight: 28,
  contentMaxWidth: 760,
  composerMaxHeight: 200,
} as const

/* ── 输入限制 ────────────────────────────────────────────────── */

/*
 * 输入框一次能贴多少字符。
 *
 * 4000 → 100000（2026-10-03）。4000 是**初始提交**就带来的（`git log -S` 只追到
 * 「初始提交：Personal Agent 0.23.0」，没有任何理由记录在案），而它的实际效果是
 * 「贴一段长日志、长报错、长代码就贴不进去」—— 这恰恰是这个应用最常干的活。
 *
 * 仍然**不是无限**，因为下游确实有代价，而且是有账可算的两条：
 *   · 提示词这边：`context-builder` 按 `budget.conversation` 裁，超出的部分模型
 *     看不到（默认 `assistant.maxTokens=4096` 时约 3686 字符）。这是既有行为，
 *     这次**没有**改 —— 见报告里「下游影响」那一节；
 *   · 渲染这边：输入框是受控组件，每敲一个键都要带着整串文本重渲一次，
 *     所以体感上限是真的存在（真机实测见报告）。
 * 10 万字符按 3 字/token 粗估约 3.3 万 token —— 仍在一线模型单轮上下文的量级内。
 *
 * 改这个数 = 改「用户能贴多长」，属于产品决定；别顺手调（`inputLength.test.ts` 盯着它）。
 */
export const MAX_INPUT_LENGTH = 100000

/* ── 文案 ────────────────────────────────────────────────────── */

export const EMPTY_THREAD_PROMPTS = [
  '读一遍这个仓库，告诉我它的整体结构',
  '帮我给 utils 里的日期函数补几个边界测试',
  '这段 diff 有什么风险？',
  '把 README 里的安装步骤写成脚本',
] as const
