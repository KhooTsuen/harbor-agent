/**
 * 配置：规范化
 *
 * 读进来的东西一律过这里 —— 用户手改过配置文件、从旧版本升级上来、
 * 或者被别的程序写过，里面什么都可能有。**不信任输入**是这一层的唯一职责。
 *
 * 旧版本兼容：老配置里 provider 是 `apiKey: "sk-..."` 明文字段。
 * 这里先把它原样搬进 `_legacyApiKey`，由 config.cjs 在 load 时
 * 移进凭证库并从文件里抹掉 —— 规范化层自己不动磁盘。
 *
 * 小工具函数与两个逐项规范化器搬到了 `config-normalize-parts.cjs`。
 */

const C = require('./config-defaults.cjs')
const budgetCore = require('./budget.cjs')
const {
  clampNumber,
  pick,
  str,
  bool,
  obj,
  normalizeProvider,
  normalizeMcpServer,
} = require('./config-normalize-parts.cjs')
const securityCfg = require('./config-security.cjs')

/**
 * 上下文基准（token）取值 + **旧默认值迁移**。
 *
 * 2026-10-11 起 `0 = 跟随模型窗口`（新默认）。但旧版本这字段是死值、默认 16384，
 * 而 `config.cjs` 的 `save()` 会把默认值一起落盘 —— 老盘上几乎都存着 `baseTokens: 16384`。
 * 若把它当成「用户上限」，跟随窗口对老用户**永远不生效**（正是这次要修的病）。
 * 所以：**旧默认值 16384 视同「没设过」→ 0**。想钉上限填别的值即可（16384 不再是合法默认）。
 */
const LEGACY_BASE_TOKENS = 16384
function contextBaseTokensOf(raw) {
  const n = Number(raw)
  if (n === LEGACY_BASE_TOKENS) return 0
  return clampNumber(n || C.DEFAULTS.context.baseTokens, 0, 1000000, C.DEFAULTS.context.baseTokens)
}

function normalize(raw) {
  const g = obj(raw)
  const general = obj(g.general)
  const assistant = obj(g.assistant)
  const tools = obj(g.tools)
  const shellPolicy = obj(tools.shellPolicy)
  const search = obj(g.search)
  const mcp = obj(g.mcp)
  const scenes = obj(g.scenes)
  const memory = obj(g.memory)
  const context = obj(g.context)
  const budget = obj(context.budget)
  const router = obj(g.router)
  const roles = obj(router.roles)
  const fallback = obj(g.fallback)
  const audit = obj(g.audit)
  const changeset = obj(g.changeset)

  const limits = obj(g.limits)
  const budgetRaw = budgetCore.legacyUnlimited(obj(g.budget)).value
  const providers =
    Array.isArray(g.providers) && g.providers.length > 0
      ? g.providers.map(normalizeProvider)
      : JSON.parse(JSON.stringify(C.DEFAULTS.providers))

  return {
    version: 2,

    profile: {
      name: typeof raw?.profile?.name === 'string' ? raw.profile.name.slice(0, 40) : '',
    },
    general: {
      theme: pick(general.theme, C.THEMES, 'default'),
      glassmorphism: bool(general.glassmorphism, false),
      animations: general.animations !== false,
      fontScale: clampNumber(general.fontScale, 80, 150, 100),
      sendOnEnter: general.sendOnEnter !== false,
      workdir: str(general.workdir),
      onboarded: bool(general.onboarded, false),
      onboardingDismissed: bool(general.onboardingDismissed, false),
      minimizeToTray: general.minimizeToTray !== false,
      autoTitle: general.autoTitle !== false,
      browserNavigation: pick(
        str(general.browserNavigation, 'ask'),
        ['ask', 'allow', 'block'],
        'ask',
      ),
    },

    providers,

    assistant: {
      name: str(assistant.name) || C.BRAND.assistant,
      systemPrompt: str(assistant.systemPrompt),
      /* 模型要真的有人提供（审计问题 25）—— 判据与回落规则见 config-model.cjs */
      model: require('./config-model.cjs').pickModel(assistant.model, providers),
      temperature: clampNumber(assistant.temperature, 0, 2, 0.7),
      topP: clampNumber(assistant.topP, 0, 1, 1),
      /* 0 = 不限（**新的默认**）。旧默认 4096 认成「没设过」→ 0，理由同任务预算：
         盘上的老数字不会自己变，不迁移这次修复对老用户就等于没发生 */
      maxTokens: clampNumber(assistant.maxTokens === 4096 ? 0 : assistant.maxTokens, 0, 128000, 0),
      historyLimit: clampNumber(assistant.historyLimit, 0, 200, 20),
      responseDepth: pick(str(assistant.responseDepth, 'standard'), ['concise', 'standard', 'detailed', 'deep'], 'standard'),
      selfReview: assistant.selfReview === true,
      streamOutput: assistant.streamOutput !== false,
      planFirst: assistant.planFirst !== false,
      /* AG-053 / A2：开工前澄清与规模确认（默认值与夹取规则在各自那个 config 里） */
      ...require('./clarify-config.cjs').normalize(assistant),
      ...require('./scale-config.cjs').normalize(assistant),
      verifyAfterEdit: assistant.verifyAfterEdit !== false,
    },

    tools: {
      permission: pick(str(tools.permission, 'ask'), C.PERMISSIONS, 'ask'),
      shellTimeout: clampNumber(tools.shellTimeout, 5, 600, 60),
      fileScope: pick(str(tools.fileScope, 'workspace'), C.FILE_SCOPES, 'workspace'),
      shellPolicy: {
        medium: pick(str(shellPolicy.medium, 'ask'), ['allow', 'ask', 'block'], 'ask'),
        high: pick(str(shellPolicy.high, 'ask'), ['allow', 'ask', 'block'], 'ask'),
        critical: pick(str(shellPolicy.critical, 'block'), ['allow', 'ask', 'block'], 'block'),
      },
      outputLimit: clampNumber(tools.outputLimit, 64_000, 16 * 1024 * 1024, 2 * 1024 * 1024),
    },

    /*
     * 网络策略。默认值 + 规范化 + 「管不到什么」的说明全在 `config-security.cjs`
     * —— 那里是这一段唯一的真相源（含它为什么必须列进本白名单的理由）。
     */
    security: securityCfg.normalizeSecurity(g.security),

    scenes: Object.fromEntries(
      C.SCENE_IDS.map((id) => {
        const entry = obj(scenes[id])
        return [id, { providerId: str(entry.providerId), model: str(entry.model) }]
      }),
    ),

    mcp: {
      servers: Array.isArray(mcp.servers)
        ? mcp.servers
            .filter((s) => s && typeof s === 'object')
            .map(normalizeMcpServer)
            .slice(0, 20)
        : [],
    },

    search: {
      provider: pick(str(search.provider, 'duckduckgo'), C.SEARCH_PROVIDERS, 'duckduckgo'),
      credentialRef: str(search.credentialRef),
      /* 旧版明文 */
      _legacyApiKey: str(search.apiKey),
      endpoint: str(search.endpoint),
      maxResults: clampNumber(search.maxResults, 1, 10, 5),
      citations: search.citations !== false,
    },

    memory: {
      autoWrite: pick(str(memory.autoWrite, 'ask'), ['auto', 'ask', 'off'], 'ask'),
      injectLimit: clampNumber(memory.injectLimit, 1, 50, 12),
      maxItems: clampNumber(memory.maxItems, 50, 5000, 800),
      retrieve: memory.retrieve !== false,
    },

    context: {
      /* 0 = 跟随模型窗口（默认）；显式值 = 用户上限，夹 0–1000000；旧死值 16384 见上面的迁移 */
      baseTokens: contextBaseTokensOf(context.baseTokens),
      budget: Object.fromEntries(
        Object.entries(C.DEFAULTS.context.budget).map(([key, value]) => [
          key,
          clampNumber(budget[key], 0, 90, value),
        ]),
      ),
      compactAt: clampNumber(context.compactAt, 0.1, 0.9, 0.4),
      autoCompactAt: clampNumber(context.autoCompactAt, 0.2, 0.95, 0.6),
    },

    router: {
      enabled: bool(router.enabled, false),
      roles: Object.fromEntries(C.MODEL_ROLES.map((role) => [role, str(roles[role])])),
    },

    fallback: {
      enabled: fallback.enabled !== false,
      attempts: clampNumber(fallback.attempts, 0, 5, 2),
      retryOn: Array.isArray(fallback.retryOn)
        ? fallback.retryOn.filter((k) => typeof k === 'string')
        : [...C.DEFAULTS.fallback.retryOn],
    },

    audit: {
      enabled: audit.enabled !== false,
      retentionDays: clampNumber(audit.retentionDays, 1, 3650, 30),
    },

    changeset: {
      enabled: changeset.enabled !== false,
      maxFileBytes: clampNumber(changeset.maxFileBytes, 1024, 64 * 1024 * 1024, 4 * 1024 * 1024),
      maxFiles: clampNumber(changeset.maxFiles, 1, 2000, 200),
    },

    /* 下载：浏览器下载落盘目录（空 = 当前会话工作目录，见 core/download-intake.cjs） */
    downloads: {
      browserDir: str(obj(g.downloads).browserDir).slice(0, 500),
    },

    /*
     * 用量闸。token 数用 clampNumber 兜底（负数、乱填都打回 0 = 不限）。
     */
    /* AG-040：任务预算（0 = 不限 = 新默认）。旧盘上的 50/100/1800/100000 已在上游
       经 `budgetCore.legacyUnlimited` 当成「没设过」→ 0；这里只做坏值兜底 */
    budget: {
      maxSteps: Math.round(clampNumber(budgetRaw.maxSteps, 0, 10_000, 0)),
      maxToolCalls: Math.round(clampNumber(budgetRaw.maxToolCalls, 0, 1_000_000, 0)),
      maxRuntime: Math.round(clampNumber(budgetRaw.maxRuntime, 0, 86400, 0)),
      maxRetries: Math.round(clampNumber(budgetRaw.maxRetries, 0, 20, 3)),
      maxTokens: Math.round(clampNumber(budgetRaw.maxTokens, 0, 1_000_000_000, 0)),
      softRatio: Math.min(1, Math.max(0, clampNumber(budgetRaw.softRatio, 0, 1, 0.8))),
    },

    /* token 优化：预热默认关（会产生真实请求与费用） */
    cache: {
      prewarm: bool(obj(g.cache).prewarm, false),
    },

    limits: {
      enabled: bool(limits.enabled, false),
      dailyTokens: Math.round(clampNumber(limits.dailyTokens, 0, 1_000_000_000, 0)),
      monthlyTokens: Math.round(clampNumber(limits.monthlyTokens, 0, 1_000_000_000, 0)),
      onExceed: pick(str(limits.onExceed, 'block'), ['block', 'warn'], 'block'),
    },

    shortcuts: obj(g.shortcuts),
    updatedAt: typeof g.updatedAt === 'number' ? g.updatedAt : 0,
  }
}

module.exports = { normalize, clampNumber, pick }
