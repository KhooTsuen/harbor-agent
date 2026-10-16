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
     * ── 后端种类（2026-10-17）──────────────────────────────────
     * `'openai'` = HTTP/SSE（`llm.cjs`）/ `'codex-cli'` = 本机 codex 子进程（`codex-cli.cjs`）。
     * ★ **缺省即 `'openai'`** —— 旧配置里没有这个字段，读进来就是 `'openai'`，
     *   行为**一字不变**（默认值即兼容，不需要写数据迁移）。见设计文档 §1。
     * ★ 不认识的写法一律回落 `'openai'`（不信任输入）—— 别让一个手改的值把
     *   供应商变成「谁都不认识的种类」，那比报错更难查。
     */
    kind: pick(str(p.kind), ['openai', 'codex-cli'], 'openai'),
    /**
     * codex-cli 用的 launcher（`codex` / `codex.cmd` / 自备 .cmd 的完整路径）。
     * 留空 = 适配器按 PATH 与 npm 全局目录自己解析 —— **不硬编码本机路径**（设计 §5.4）。
     */
    codexPath: str(p.codexPath),

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

/* ══════════════════════════════════════════════════════════════
   单价（A-展示）：归一化
   ══════════════════════════════════════════════════════════════ */

/** 三个计费项，少一个就说明这份价不可用（宁可不显示金额，也不显示错的） */
const PRICE_KEYS = ['inMiss', 'inHit', 'out']

/**
 * 一项单价：`{peak, offPeak}` 或**单个数**，统一成 `{peak, offPeak}`。
 *
 * `def` = 内置默认值（`undefined` 表示这个模型没有默认价，比如用户自己新加的）。
 * 规则：坏值 / 缺失 → 回落 `def`；`def` 也没有 → 返回 `null`（**绝不猜一个价**，
 * 调用方拿到 `null` 就该整份丢掉 → 界面显示「未配置单价」而不是「¥0.00」）。
 */
function priceItem(raw, def) {
  const src = obj(raw)
  const num = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  /* 写成了对象 → 认 peak / offPeak（只给 peak 时 offPeak 取同值？不 —— 回落默认，
     因为「只写了高峰价」十有八九是漏了，给它编个空闲价反而是造数） */
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const peak = num(src.peak, def ? def.peak : null)
    const offPeak = num(src.offPeak, def ? def.offPeak : null)
    if (peak === null || offPeak === null) return def || null
    return { peak, offPeak }
  }
  /* 写成了单个数 → 两档同值（= 这家的价不分时段） */
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0) return { peak: n, offPeak: n }
  return def || null
}

/** 一个模型的三项价；三项不全 → 整份丢掉（回落默认，或 null） */
function priceModel(raw, def) {
  const src = obj(raw)
  const out = {}
  for (const key of PRICE_KEYS) {
    const item = priceItem(src[key], def ? def[key] : null)
    if (item) out[key] = item
  }
  if (!out.inMiss || !out.inHit || !out.out) return def || null
  return out
}

/**
 * 整段 `pricing` 归一化。**顺序很重要**：先铺内置默认，再把用户值**深合并**上去 ——
 * 老配置没有 `pricing` 段 → 全走默认；用户只填了一部分 → 缺的键回落到默认，
 * **不是整段替换**（整段替换会让「只改了个 out 的人」把另两个价一起清空）。
 */
function normalizePricing(raw) {
  const src = obj(raw)
  const base = C.DEFAULTS.pricing
  const providers = {}
  const seed = (pid, model, price) => {
    if (!providers[pid]) providers[pid] = {}
    providers[pid][model] = {
      inMiss: { ...price.inMiss },
      inHit: { ...price.inHit },
      out: { ...price.out },
    }
  }

  for (const [pid, models] of Object.entries(base.providers ?? {})) {
    for (const [model, price] of Object.entries(models)) seed(pid, model, price)
  }
  for (const [pid, models] of Object.entries(obj(src.providers))) {
    for (const [model, price] of Object.entries(obj(models))) {
      const merged = priceModel(price, providers[pid] ? providers[pid][model] : null)
      if (merged) seed(pid, model, merged)
    }
  }

  return {
    currency: str(src.currency, base.currency).slice(0, 10) || base.currency,
    /* 单位固定：官方口径就是「元 / 百万 tokens」，不开放改（改了金额会差几个数量级） */
    unit: base.unit,
    peakMode: pick(str(src.peakMode, base.peakMode), ['auto', 'peak', 'offPeak'], base.peakMode),
    providers,
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
  normalizePricing,
}
