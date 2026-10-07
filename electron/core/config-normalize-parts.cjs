/**
 * 配置规范化：原料（从 config-normalize.cjs 拆出来的）
 *
 * 「怎么把脏值变成安全值」的几个小函数 + 两个逐项规范化器（供应商 / MCP 服务器）。
 * 顶层那个 normalize() 在 config-normalize.cjs —— 它用这里的东西拼出来。
 *
 * 读进来的东西一律过这里，**不信任输入**是这一层的唯一职责。
 */

const C = require('./config-defaults.cjs')
const providerCaps = require('./provider-capabilities.cjs')

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
    /** DeepSeek strict 模式（Beta）：给每个 function 加 strict:true。
     *  只在 DeepSeek 官方 /beta 端点有效，中转站不认；默认关。 */
    strictTools: p.strictTools === true,
    /* 用户手填的模型能力覆盖（按模型名分组）。**必须在白名单里**，否则改了被静默丢掉。
       形状与优先级见 provider-capabilities.cjs —— 覆盖 > 内置预设 > 未知。 */
    modelCapabilities: providerCaps.cleanOverrides(p.modelCapabilities),
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
    /* 用应用自带的 Node 跑（自己写的 JS 服务器不必先装 Node） */
    useBundledNode: bool(s.useBundledNode, false),
  }
}

module.exports = {
  clampNumber,
  pick,
  str,
  bool,
  obj,
  strMap,
  normalizeProvider,
  normalizeMcpServer,
}
