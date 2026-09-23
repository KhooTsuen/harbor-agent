/**
 * Provider 能力查询：能力维度 + 预设匹配 + 用户覆盖 + 缺口计算
 *
 * ⚠️⚠️ **这里全部是「声明」，不是「探测」。**
 *
 * 预设来自 `provider-presets.cjs`（公开文档的声明），覆盖来自用户手填。
 * 没有一处是发真实请求试出来的 —— 真要试就得联网，而本项目的内核自检**不联网**
 * （AGENT.md 硬约束）。这一轮**不做**真实探测：探测要面对各家的失败模式
 * （中转站超时、把不支持的工具参数当普通参数吞掉、限流返回 429……），
 * 那是一件事，不是顺手能加的。
 *
 * 所以这个模块给的东西只有四样：**声明 + 预设 + 覆盖 + 查询**。
 * 每一处给用户看的地方都必须写明这一点（界面上用的是下面的 `NOTE`，
 * 不许另外写一句「已检测」之类的话）。
 *
 * 三态很重要：
 *   true  支持        false 明确不支持        **null 未知（不猜）**
 * 缺口也分两种，别混：
 *   missing（明确 false）→ 可以拦、可以警告「会失败」
 *   unknown（null）      → 只能说「说不准」，不能说「不行」
 *
 * 优先级固定：**用户覆盖 > 内置预设 > 未知**。
 *
 * 能力维度命名对齐业界通用叫法（OpenRouter / LiteLLM 一类），不自己造词。
 */

const presets = require('./provider-presets.cjs')

/** 十个维度。加维度时**四处要一起改**：这里、LABELS、provider-presets、src/types/model-caps.ts */
const DIMENSIONS = [
  'chat',
  'streaming',
  'tool_call',
  'vision',
  'structured_output',
  'reasoning',
  'context_window',
  'max_output',
  'attachments',
  'search',
]

/** 只有这两个是数字，其余都是 true/false/null */
const NUMERIC_DIMS = ['context_window', 'max_output']

const LABELS = {
  chat: '对话',
  streaming: '流式输出',
  tool_call: '工具调用',
  vision: '读图',
  structured_output: '结构化输出',
  reasoning: '推理',
  context_window: '上下文容量',
  max_output: '单次输出上限',
  attachments: '附件',
  search: '联网搜索',
}

/** 给用户看的一句话。界面上直接用它，别各写各的 */
const NOTE = '这是声明与预设，不是探测 —— 拿不准的一律标「未知」；真探测要联网，本项目没做'

/** 全未知的一张空表 */
function blank() {
  return Object.fromEntries(DIMENSIONS.map((dim) => [dim, null]))
}

/**
 * 把外部给的东西（预设 / 用户覆盖）过滤成规范形状。
 *
 * 不认识的维度名**直接丢掉** —— 宁可不显示，也不要让界面出现一个没人认识的词。
 * 值也不信任：布尔维度只认 true/false，数字维度必须是正数。
 */
function sanitize(raw) {
  const out = blank()
  if (!raw || typeof raw !== 'object') return out

  for (const dim of DIMENSIONS) {
    const value = raw[dim]
    if (value === undefined || value === null) continue

    if (NUMERIC_DIMS.includes(dim)) {
      const n = Number(value)
      out[dim] = Number.isFinite(n) && n > 0 ? Math.round(n) : null
    } else {
      out[dim] = value === true ? true : value === false ? false : null
    }
  }
  return out
}

/**
 * 挑出「这个模型」的用户覆盖。
 *
 * 两种写法都认，因为调用方手里拿到的可能是任意一种：
 *   · `{ vision: true }`                        —— 直接就是维度表
 *   · `{ 'deepseek-chat': { vision: true } }`   —— 按模型分组（配置里存的就是这个形状）
 * 判据：出现任何一个维度名就当成维度表 —— 模型名不会正好叫 `vision`。
 */
function overridesFor(model, overrides) {
  if (!overrides || typeof overrides !== 'object') return {}
  const keys = Object.keys(overrides)
  if (keys.some((key) => DIMENSIONS.includes(key))) return overrides

  const own = overrides[String(model ?? '').trim()]
  return own && typeof own === 'object' ? own : {}
}

/**
 * 解析一个模型的能力。
 *
 * @param {string} model 模型名（各家写法都行，预设那边会归一化）
 * @param {object} [overrides] 用户覆盖，两种形状都认（见 overridesFor）
 * @returns {{ model: string, caps: object, source: object, preset: string|null, presetNote: string }}
 *          `source[dim]` ∈ 'override' | 'preset' | 'unknown' —— 界面上能看出每个结论是谁给的
 */
function resolve(model, overrides) {
  const name = String(model ?? '').trim()
  const hit = presets.match(name)
  const base = hit ? sanitize(hit.caps) : blank()
  const own = sanitize(overridesFor(name, overrides))

  const caps = { ...base }
  const source = {}
  for (const dim of DIMENSIONS) {
    if (own[dim] !== null) {
      caps[dim] = own[dim]
      source[dim] = 'override'
    } else {
      source[dim] = base[dim] === null ? 'unknown' : 'preset'
    }
  }

  return {
    model: name,
    caps,
    source,
    preset: hit ? hit.id : null,
    presetNote: hit ? hit.note : '',
  }
}

/**
 * 这个模型**缺**哪些能力 —— 给「提前警告」用。
 *
 * @param {string} model
 * @param {string|string[]} needs 这次任务需要的能力（维度名）
 * @param {object} [overrides] 用户覆盖
 * @returns {{ model, caps, source, preset, presetNote, ok, missing, unknown }}
 *          ok = 没有**明确不支持**的项（说不准的不算失败）
 */
function missing(model, needs, overrides) {
  const list = (Array.isArray(needs) ? needs : [needs])
    .map((dim) => String(dim))
    .filter((dim) => DIMENSIONS.includes(dim))

  const resolved = resolve(model, overrides)
  const gaps = list.filter((dim) => resolved.caps[dim] === false)
  const unsure = list.filter((dim) => resolved.caps[dim] === null)

  return { ...resolved, needs: list, ok: gaps.length === 0, missing: gaps, unknown: unsure }
}

/**
 * 收紧用户手填的覆盖：只留「认识的维度 + 合法的值」，其余丢掉。
 *
 * 为什么规范化层也要过一次：用户手改过 config.json、或从旧版本升上来，里面什么都可能有。
 * **不信任输入**是那一层的规矩，规则放在这里（能力的词汇表属于本模块），配置层只管调用。
 * 返回 `{ '模型名': { vision: true, context_window: 128000 } }` —— 只留**显式写了**的维度，
 * 免得落盘时给每个模型都写一份全是 null 的空表。
 */
function cleanOverrides(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out

  for (const [model, caps] of Object.entries(raw)) {
    const name = String(model).trim()
    if (!name || !caps || typeof caps !== 'object') continue

    const clean = {}
    for (const dim of DIMENSIONS) {
      const value = caps[dim]
      if (value === true || value === false) clean[dim] = value
      else if (NUMERIC_DIMS.includes(dim)) {
        const n = Number(value)
        if (value !== undefined && value !== null && Number.isFinite(n) && n > 0) clean[dim] = Math.round(n)
      }
    }
    if (Object.keys(clean).length > 0) out[name] = clean
  }
  return out
}

/**
 * 给界面用：把所有供应商声明的模型算成一张矩阵，跟着 config:get 一起下发。
 *
 * 同一个模型出现在多家供应商里时**以先出现的为准** —— 预设是按模型名给的，
 * 差别只可能来自各自的用户覆盖，先声明的那家说了算（不合并，免得两个覆盖
 * 拼出一个谁都没配过的结果）。
 */
function forProviders(providers) {
  const models = {}
  for (const provider of Array.isArray(providers) ? providers : []) {
    const list = Array.isArray(provider?.models) ? provider.models : []
    for (const raw of list) {
      const name = String(raw ?? '').trim()
      if (!name || models[name]) continue
      const resolved = resolve(name, provider?.modelCapabilities)
      models[name] = {
        caps: resolved.caps,
        source: resolved.source,
        preset: resolved.preset,
        presetNote: resolved.presetNote,
      }
    }
  }

  return {
    dims: [...DIMENSIONS],
    labels: { ...LABELS },
    numeric: [...NUMERIC_DIMS],
    models,
    note: NOTE,
  }
}

module.exports = {
  DIMENSIONS,
  NUMERIC_DIMS,
  LABELS,
  NOTE,
  blank,
  sanitize,
  cleanOverrides,
  resolve,
  missing,
  forProviders,
  presetList: presets.list,
}
