/**
 * 配置：规范化
 *
 * 读进来的东西一律过这里 —— 用户手改过配置文件、从旧版本升级上来、
 * 或者被别的程序写过，里面什么都可能有。**不信任输入**是这一层的唯一职责。
 *
 * 旧版本兼容：老配置里 provider 是 `apiKey: "sk-..."` 明文字段。
 * 这里先把它原样搬进 `_legacyApiKey`，由 config.cjs 在 load 时
 * 移进凭证库并从文件里抹掉 —— 规范化层自己不动磁盘。
 */

const C = require('./config-defaults.cjs')

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function bool(value, fallback = false) {
  if (value === undefined || value === null) return fallback
  return value === true
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** 字符串字典（env 之类） */
function strMap(value) {
  return Object.fromEntries(Object.entries(obj(value)).map(([k, v]) => [k, String(v)]))
}

function normalizeProvider(raw, index) {
  const p = obj(raw)
  const id = str(p.id) || `provider-${index + 1}`
  return {
    id,
    name: str(p.name) || '未命名供应商',
    baseUrl: str(p.baseUrl),
    credentialRef: str(p.credentialRef) || `provider:${id}`,
    /* 旧版明文字段：搬出来交给上层迁移，不落回文件 */
    _legacyApiKey: str(p.apiKey),
    chatPath: str(p.chatPath) || '/chat/completions',
    models: Array.isArray(p.models) ? p.models.filter((m) => typeof m === 'string') : [],
    enabled: p.enabled !== false,

    /*
     * ── 高级：给中转站/怪站点留的兜底 ──
     * 这三个必须在白名单里，否则用户改了配置会被**静默丢掉**（改了没生效还不报错）。
     */

    /** 直接 merge 进请求体的字段（优先级最高）。OpenRouter 的后端选择、
     *  硅基流动 Qwen3 的 enable_thinking 都走这里 */
    extraBody: obj(p.extraBody),
    /** 明确不要发的字段名 */
    omitParams: Array.isArray(p.omitParams)
      ? p.omitParams.filter((k) => typeof k === 'string' && k)
      : [],
    /** 是否要上游在流式响应里回 usage（有些站点不认 stream_options，可关） */
    streamUsage: p.streamUsage !== false,
  }
}

function normalizeMcpServer(raw, index) {
  const s = obj(raw)
  const allowlist = Array.isArray(s.envAllowlist)
    ? s.envAllowlist.filter((k) => typeof k === 'string')
    : null

  return {
    id: str(s.id) || `mcp-${index + 1}`,
    name: str(s.name) || `MCP ${index + 1}`,
    command: str(s.command),
    args: Array.isArray(s.args) ? s.args.map(String) : [],
    /** 显式配置的环境变量（用户自己填的，可能含密钥 → 审计/诊断要脱敏） */
    env: strMap(s.env),
    enabled: s.enabled !== false,
    /* ── 隔离相关，默认最保守 ── */
    inheritEnvironment: bool(s.inheritEnvironment, false),
    envAllowlist: allowlist ?? [...C.MCP_ENV_ALLOWLIST],
    cwd: str(s.cwd),
    network: pick(str(s.network, 'ask'), ['deny', 'ask', 'allow'], 'ask'),
    timeoutMs: clampNumber(s.timeoutMs, 1000, 600_000, 30_000),
    permission: pick(str(s.permission, 'ask'), C.PERMISSIONS, 'ask'),
  }
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

  const providers =
    Array.isArray(g.providers) && g.providers.length > 0
      ? g.providers.map(normalizeProvider)
      : JSON.parse(JSON.stringify(C.DEFAULTS.providers))

  return {
    version: 2,

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
      model: str(assistant.model) || 'deepseek-chat',
      temperature: clampNumber(assistant.temperature, 0, 2, 0.7),
      topP: clampNumber(assistant.topP, 0, 1, 1),
      maxTokens: clampNumber(assistant.maxTokens, 256, 128000, 4096),
      historyLimit: clampNumber(assistant.historyLimit, 0, 200, 20),
      responseDepth: pick(
        str(assistant.responseDepth, 'standard'),
        ['concise', 'standard', 'detailed', 'deep'],
        'standard',
      ),
      selfReview: assistant.selfReview === true,
      streamOutput: assistant.streamOutput !== false,
      planFirst: assistant.planFirst !== false,
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

    shortcuts: obj(g.shortcuts),
    updatedAt: typeof g.updatedAt === 'number' ? g.updatedAt : 0,
  }
}

module.exports = { normalize, clampNumber, pick }
