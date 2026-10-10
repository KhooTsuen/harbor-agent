/**
 * 配置：默认值
 *
 * 品牌标识与枚举搬到了 `config-constants.cjs`（那边改品牌 / 权限档位，这边调默认值）。
 *
 * 从 config.cjs 拆出来的 —— 加完安全相关的新段（capability / shellPolicy /
 * mcp 隔离 / memory / context / router / audit）之后，那边必然超 300 行。
 *
 * 这里只有默认值，没有逻辑。
 */

const { NETWORK_MODES, SECURITY_DEFAULTS } = require('./config-security.cjs')
const { MCP_ENV_ALLOWLIST } = require('./config-mcp-env.cjs')
const {
  BRAND,
  LEGACY,
  THEMES,
  PERMISSIONS,
  FILE_SCOPES,
  RISK_LEVELS,
  SEARCH_PROVIDERS,
  SCENE_IDS,
  MODEL_ROLES,
} = require('./config-constants.cjs')

/* MCP 的环境变量白名单在 config-mcp-env.cjs（连同「为什么一个都不能删」的说明） */

/* ══════════════════════════════════════════════════════════════
   默认值
   ══════════════════════════════════════════════════════════════ */

const DEFAULTS = {
  version: 2,

  /** 个人资料：侧栏左下角那个圆显示什么（头像文件在 data/avatars/） */
  profile: {
    /** 昵称；空 = 就显示「我」 */
    name: '',
  },

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
    /** 单次回复的输出上限。**0 = 不限**（原来 4096 就是长回复被砍断的凶手：363 次请求里输出上限正好是它）。不限时不带这个参数，上下文基准见 `context-builder.cjs` */
    maxTokens: 0,
    historyLimit: 20,
    /** 回答深度：与推理 effort、输出上限解耦 */
    responseDepth: 'standard',
    selfReview: false,
    streamOutput: true,
    /** 计划 → 执行 → 验证：先让模型出计划再动手 */
    planFirst: true,
    ...require('./clarify-config.cjs').DEFAULTS,
    ...require('./scale-config.cjs').DEFAULTS,
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

  /*
   * 网络策略。默认值与**它管不到什么**的说明都在 `config-security.cjs` ——
   * 这里只引进来（那段注释本该挨着默认值，挪走就会漂）。
   */
  security: SECURITY_DEFAULTS,

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
     * { id, name, command, args, env, enabled, useBundledNode,
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
    /**
     * 上下文基准（token），字符预算 = ×3。**0 = 跟随模型窗口**（默认）——
     * 内核按 `min(窗口 × 80%, 本值)` 算；本值非 0 = 用户钉死的上限（刹车）。
     * 窗口未知且本值为 0 → 退回 `DEFAULT_CONTEXT_TOKENS`（见 context-window.cjs）。
     * 2026-10-11 前是 16384 死值，跟窗口脱钩 —— 换 1M 窗口的模型也没用。
     */
    baseTokens: 0,
    /**
     * 各段占上下文窗口的比例（%）。
     *
     * ⚠️ 2026-10-08：真正生效的只有 **memory / project / task / conversation** 四个。
     *   `system` / `tools` / `reserve` 声明了，但 `context-builder.assemble` 从不用它们 ——
     *   实测把 `budget.system` 改成 90，各层输出**逐字不变**。
     *
     *   这三个键**保留**，唯一理由是**让老盘上已经存过它们的配置能原样读回来**；
     *   但请记住：**调它们不会改变任何行为**（内核不会再假装在管）。
     *
     *   「哪些真的生效」的唯一真相源在 `electron/core/context-builder.cjs` 的 `DEFAULT_BUDGET`
     *   （这个对象必须是它的超集），有自检盯着：`116-project-context-complete` 的
     *   「表里每一项都真的生效」。
     */
    budget: {
      /* ↓ 这三个是真死键：老配置里可能有，内核不管（别再照它们估额度） */
      system: 10,
      tools: 20,
      reserve: 10,
      /* ↓ 这四个真的管用（生效清单的唯一来源见上面注释） */
      memory: 5,
      project: 15,
      task: 10,
      conversation: 30,
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
   * 用量闸：调模型之前查一次账，超了就拦。按 **token 数** 而不是金额 ——
   * 金额要维护价目表，中转站计价又各不相同。
   */
  /**
   * 每个任务的执行预算（AG-040）。任务自己的 `budget` 覆盖这里的值；**五项默认全是不限**
   * （只有自动重试不是上限，而是「自动救一把几次」；旧盘的 50/100/1800/100000 会被迁移）
   */
  budget: {
    maxSteps: 0,
    maxToolCalls: 0,
    maxRuntime: 0,
    maxRetries: 3,
    maxTokens: 0,
    /** 软阈值（0~1，token 优化）：到比例就提醒模型省着点；maxTokens 不限时它不会触发 */
    softRatio: 0.8,
  },

  /**
   * 缓存相关（token 优化）。
   * prewarm = 启动后发一次「只带稳定前缀」的预热请求（默认**关**：会产生真实费用）。
   */
  cache: {
    prewarm: false,
  },

  /*
   * 用量闸：**默认不限**（关着）。这是个保护装置，不该在用户没要求的时候拦住他 ——
   * 想按量控的用户自己去「设置 → 用量」打开并填上限。
   */
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
  NETWORK_MODES,
  SECURITY_DEFAULTS,
  DEFAULTS,
}
