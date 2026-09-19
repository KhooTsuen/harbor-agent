/**
 * 配置：默认值与常量
 *
 * 从 config.cjs 拆出来的 —— 加完安全相关的新段（capability / shellPolicy /
 * mcp 隔离 / memory / context / router / audit）之后，那边必然超 300 行。
 *
 * 这里只有数据和枚举，没有逻辑。
 */

/* ══════════════════════════════════════════════════════════════
   品牌
   ══════════════════════════════════════════════════════════════ */

/** 产品标识。改品牌时只改这里 + package.json，其余地方都引用它 */
const BRAND = {
  /** 包名 / npm name / MCP clientInfo */
  id: 'personal-agent',
  /** 界面显示名 */
  name: 'Personal Agent',
  /** 助手默认名字（用户可改） */
  assistant: 'Agent',
  /** localStorage / 导出文件的命名空间 */
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

/**
 * MCP 默认环境变量白名单。
 *
 * 为什么非要留这几个：Windows 上少了 SystemRoot / windir，很多程序
 * **根本起不来**（加载 DLL 失败），报的错还和权限无关，极难排查。
 * 这几个是「让进程能跑」的最小集，不含任何密钥。
 */
const MCP_ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'ProgramFiles',
  'ProgramData',
  'LANG',
  'LC_ALL',
  'PYTHONIOENCODING',
]

/* ══════════════════════════════════════════════════════════════
   默认值
   ══════════════════════════════════════════════════════════════ */

const DEFAULTS = {
  version: 2,

  general: {
    theme: 'default',
    glassmorphism: false,
    animations: true,
    fontScale: 100,
    sendOnEnter: true,
    /** 工作目录（空 = 用 data/workspace） */
    workdir: '',
    onboarded: false,
    onboardingDismissed: false,
    minimizeToTray: true,
    autoTitle: true,
    /** 浏览器标签页：
     *  'ask' = 外链先问一次；'allow' = 直接放行 http(s)；'block' = 只允许 about:blank */
    browserNavigation: 'ask',
  },

  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      /** 真正的密钥在凭证库里，这里只有引用名 */
      credentialRef: 'provider:deepseek',
      chatPath: '/chat/completions',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      enabled: true,
      /* 高级兜底项：默认全空/开，不影响任何现有行为 */
      extraBody: {},
      omitParams: [],
      streamUsage: true,
    },
  ],

  assistant: {
    name: BRAND.assistant,
    systemPrompt: '',
    model: 'deepseek-chat',
    temperature: 0.7,
    topP: 1,
    maxTokens: 4096,
    historyLimit: 20,
    /** 回答深度：与推理 effort、输出上限解耦 */
    responseDepth: 'standard',
    selfReview: false,
    streamOutput: true,
    /** 计划 → 执行 → 验证：先让模型出计划再动手 */
    planFirst: true,
    /** 验证阶段：改完代码主动跑一次验证命令 */
    verifyAfterEdit: true,
  },

  tools: {
    permission: 'ask',
    shellTimeout: 60,
    /** 文件访问范围。**默认只给工作目录** */
    fileScope: 'workspace',
    /** 各风险等级怎么处理 */
    shellPolicy: { medium: 'ask', high: 'ask', critical: 'block' },
    /** 单次工具输出上限（字节） */
    outputLimit: 2 * 1024 * 1024,
  },

  scenes: {
    chat: { providerId: '', model: '' },
    title: { providerId: '', model: '' },
    prompt: { providerId: '', model: '' },
    translate: { providerId: '', model: '' },
    suggest: { providerId: '', model: '' },
    compact: { providerId: '', model: '' },
    ocr: { providerId: '', model: '' },
    image: { providerId: '', model: '' },
  },

  /* 生图相关的杂项设置 */
  image: {
    /** 保存目录。空 = 工作目录下的 generated/；填了就用填的（绝对路径） */
    dir: '',
  },

  mcp: {
    /**
     * 每个 server：
     * { id, name, command, args, env, enabled,
     *   inheritEnvironment, envAllowlist, cwd, network, timeoutMs, permission }
     * **默认不继承环境变量、不给网络、工具按写操作对待。**
     */
    servers: [],
  },

  search: {
    provider: 'duckduckgo',
    credentialRef: '',
    endpoint: '',
    maxResults: 5,
    /** 结果带引用编号，模型回答要能对上号 */
    citations: true,
  },

  memory: {
    /** 'auto' = 用户明说就写；'ask' = 模型建议时问一次；'off' = 只读不写 */
    autoWrite: 'ask',
    /** 每轮最多注入几条 */
    injectLimit: 12,
    /** 总量上限，超了提示清理 */
    maxItems: 800,
    /** 按相关性挑，而不是全塞 */
    retrieve: true,
  },

  context: {
    /** 各段占上下文窗口的比例（%） */
    budget: {
      system: 10,
      memory: 5,
      project: 15,
      task: 10,
      conversation: 30,
      tools: 20,
      reserve: 10,
    },
    /** 到这个占比提示可以压缩 */
    compactAt: 0.4,
    /** 到这个占比后台自动压缩 */
    autoCompactAt: 0.6,
  },

  /** 模型路由：不同活儿派不同模型 */
  router: {
    enabled: false,
    roles: { fast: '', reasoning: '', coding: '', vision: '', cheap: '' },
  },

  /** 失败重试与降级 */
  fallback: {
    enabled: true,
    attempts: 2,
    retryOn: ['timeout', 'rate_limit', 'server', 'network'],
  },

  /** 工具调用审计 */
  audit: {
    enabled: true,
    retentionDays: 30,
  },

  /** 文件改动事务 */
  changeset: {
    enabled: true,
    /** 单文件超过这个大小就不做快照（会撑爆磁盘） */
    maxFileBytes: 4 * 1024 * 1024,
    maxFiles: 200,
  },

  /*
   * 用量闸：调模型之前查一次账，超了就拦。
   * 按 **token 数** 而不是金额 —— 金额要维护价目表，中转站计价又各不相同。
   */
  /**
   * 每个任务的执行预算（AG-040）。任务自己的 `budget` 会覆盖这里的值。
   * `0` = 不限。
   */
  budget: {
    maxSteps: 50,
    maxToolCalls: 100,
    maxRuntime: 1800,
    maxRetries: 3,
    maxTokens: 100000,
  },

  limits: {
    enabled: false,
    /** 0 = 不限 */
    dailyTokens: 0,
    monthlyTokens: 0,
    /** block = 拦住；warn = 只提示 */
    onExceed: 'block',
  },

  shortcuts: {},
  updatedAt: 0,
}

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
  MCP_ENV_ALLOWLIST,
  DEFAULTS,
}
