/**
 * 品牌标识 + 枚举常量（从 config-defaults.cjs 拆出来的）
 *
 * 这里只有「产品叫什么」和几个取值清单。默认值那一大坨在 config-defaults.cjs ——
 * 拆开是因为两边长得像、改的理由却完全不同：改品牌 / 加一档权限 = 动这里；
 * 调默认值 = 动那边。
 */

/* ══════════════════════════════════════════════════════════════
   品牌
   ══════════════════════════════════════════════════════════════ */

/** 产品标识。改品牌时只改这里 + package.json，其余地方都引用它 */
const BRAND = {
  /** 包名 / npm name / MCP clientInfo */
  id: 'harbor-agent',
  /** 界面显示名 */
  name: 'Harbor',
  /** 助手默认名字（用户可改） */
  assistant: 'Agent',
  /* localStorage/导出文件的命名空间：改品牌时**不要动它** —— 老用户的设置与布局都挂在这个 key 下 */
  namespace: 'personal-agent',
  /** 子进程标记环境变量名 */
  envFlag: 'PERSONAL_AGENT_PTY',
}

/** 旧品牌遗留的字符串 —— 迁移与清理时用，**新代码不许引用** */
const LEGACY = {
  namespace: 'codex-workbench',
  localStorageKeys: ['codex-workbench:app', 'codex-workbench:settings'],
  themeIds: ['codex'],
  envFlag: 'CODEX_WORKBENCH_PTY',
}

/* ══════════════════════════════════════════════════════════════
   枚举
   ══════════════════════════════════════════════════════════════ */

/** 主题 id。**不再用产品名当主题名** */
const THEMES = ['default', 'chatgpt', 'spec', 'light', 'system']

/** 工具权限三档 */
const PERMISSIONS = ['full', 'ask', 'readonly']

/** 文件访问范围 */
const FILE_SCOPES = ['workspace', 'granted', 'full']

/** Shell 风险分级 */
const RISK_LEVELS = ['low', 'medium', 'high', 'critical']

/** 搜索后端 */
const SEARCH_PROVIDERS = ['tavily', 'bocha', 'duckduckgo', 'custom']

/** 场景模型 */
const SCENE_IDS = ['chat', 'title', 'prompt', 'translate', 'suggest', 'compact', 'ocr', 'image']

/** 模型角色（路由器用） */
const MODEL_ROLES = ['fast', 'reasoning', 'coding', 'vision', 'cheap']

module.exports = {
  BRAND,
  LEGACY,
  THEMES,
  PERMISSIONS,
  FILE_SCOPES,
  RISK_LEVELS,
  SEARCH_PROVIDERS,
  SCENE_IDS,
  MODEL_ROLES,
}
