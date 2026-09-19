/**
 * 全局脱敏
 *
 * 一条规矩：**Secret 不许离开凭证库**。
 * 日志、会话、备份、诊断包、导出、审计、错误信息——都要先过这里。
 *
 * 两种脱敏方式配合使用：
 *
 *   ① 精确脱敏（记名法）
 *      凭证库加载过的真实 key 会被登记进来，之后任何文本里出现它
 *      一律换掉。比正则可靠得多——不管它被拼进 URL、header 还是命令行。
 *
 *   ② 模式脱敏（正则）
 *      兜住「我们没见过但看起来就是密钥」的东西：别人的 token、
 *      用户手贴进对话里的 key、各类云厂商前缀。
 *
 * 刻意不做的事：**不猜**。像 `password: xxx` 这种只在字段名明确时才动，
 * 免得把用户正经内容（比如在讨论「password 字段怎么校验」）也打码。
 */

/** 已知的真实密钥值（凭证库加载时登记） */
const known = new Set()

const PLACEHOLDER = '***已隐藏***'

/** 至少这么长才当成密钥，避免把 `key-1` 这种正常标识误伤 */
const MIN_SECRET_LENGTH = 8

/**
 * 登记一个真实密钥 —— 之后它在任何输出里都会被替换掉。
 * 传空值会被忽略（空串替换会把所有文本撕碎）。
 */
function remember(value, label = '') {
  const text = String(value ?? '')
  if (text.length < MIN_SECRET_LENGTH) return
  known.add(text)
  if (label) labels.set(text, label)
}

const labels = new Map()

/** 忘掉一个密钥（用户删了 Provider / 换了 key） */
function forget(value) {
  known.delete(String(value ?? ''))
}

function forgetAll() {
  known.clear()
  labels.clear()
}

/**
 * 文本脱敏。**这是唯一对外的主入口**，任何要落盘或外发的内容都该过它。
 */
function redact(input) {
  let text = typeof input === 'string' ? input : String(input ?? '')
  if (!text) return text

  /* ① 精确替换：先长后短，避免长 key 被短 key 截断 */
  if (known.size > 0) {
    const ordered = [...known].sort((a, b) => b.length - a.length)
    for (const secret of ordered) {
      if (secret && text.includes(secret)) {
        const label = labels.get(secret)
        text = text.split(secret).join(label ? `***${label}***` : PLACEHOLDER)
      }
    }
  }

  /* ② 模式替换 */
  return applyPatterns(text)
}

const PATTERNS = [
  /* Authorization / Bearer */
  [/(Bearer|Token)\s+[A-Za-z0-9._~+/-]{12,}=*/gi, `$1 ${PLACEHOLDER}`],
  /* 常见厂商前缀：OpenAI / Anthropic / GitHub / Google / Slack / AWS / HuggingFace */
  [/\b(sk|rk|pk|api|key|secret|token)[-_][A-Za-z0-9_-]{16,}\b/gi, PLACEHOLDER],
  [/\bsk-[A-Za-z0-9-]{20,}\b/g, PLACEHOLDER],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, PLACEHOLDER],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, PLACEHOLDER],
  [/\bAIza[A-Za-z0-9_-]{30,}\b/g, PLACEHOLDER],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, PLACEHOLDER],
  [/\bAKIA[0-9A-Z]{16}\b/g, PLACEHOLDER],
  [/\bhf_[A-Za-z0-9]{30,}\b/g, PLACEHOLDER],
  /* JWT */
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, PLACEHOLDER],
  /* 私钥块 */
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    `-----BEGIN PRIVATE KEY-----${PLACEHOLDER}-----END PRIVATE KEY-----`,
  ],
  /* URL 里的凭据  https://user:pass@host */
  [/(\bhttps?:\/\/[^\s/@:]+):[^\s/@]+@/gi, `$1:${PLACEHOLDER}@`],
  /* 显式字段：api_key=xxx / "apiKey": "xxx" / apikey: xxx */
  [
    /((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd)["']?\s*[:=]\s*["']?)([^\s"',;&)\]}]{6,})/gi,
    `$1${PLACEHOLDER}`,
  ],
]

function applyPatterns(text) {
  let out = text
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** 字段名看起来就是敏感的吗 */
const SECRET_KEY =
  /(api[_-]?key|apikey|secret|token|password|passwd|credential|authorization|cookie|private[_-]?key|session[_-]?id)/i

/** 这个字段名是不是敏感 */
function isSecretKey(name) {
  return SECRET_KEY.test(String(name ?? ''))
}

/**
 * 深度脱敏一个对象（用于审计、诊断、导出）。
 *
 * · 字段名命中 SECRET_KEY → 整个值换掉（保留「有没有值」这个信息）
 * · 字符串值 → 过一遍文本脱敏
 * · 深度与数组长度都设上限，避免把超大对象整个走一遍
 *
 * @param {unknown} value
 * @param {number} [maxDepth]
 */
function scrub(value, maxDepth = 8) {
  return walk(value, 0, maxDepth)
}

function walk(value, depth, maxDepth) {
  if (depth > maxDepth) return '（太深，已省略）'

  if (typeof value === 'string') {
    /* 整串就是一个已知密钥 → 全部换掉；否则按模式过一遍 */
    return redact(value)
  }
  if (value === null || value === undefined) return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'function') return '（函数）'

  if (Array.isArray(value)) {
    const head = value.slice(0, 50).map((item) => walk(item, depth + 1, maxDepth))
    if (value.length > 50) head.push(`…还有 ${value.length - 50} 项`)
    return head
  }

  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (isSecretKey(key)) {
        const text = String(item ?? '')
        out[key] = text ? `***${text.length} 字符已隐藏***` : ''
        continue
      }
      out[key] = walk(item, depth + 1, maxDepth)
    }
    return out
  }

  return String(value)
}

/** 这一段文本里有没有疑似密钥（诊断包末尾自检用） */
function looksSecret(text) {
  const sample = String(text ?? '')
  if (!sample) return false
  for (const secret of known) if (secret && sample.includes(secret)) return true
  return PATTERNS.every(([pattern]) => !pattern.test(sample)) ? false : true
}

/**
 * 轻量脱敏 + 截断（把工具参数存进任务台账时用）。
 *
 * 和 `scrub` 的区别：这里**不追求深度**，只追求两件事——
 *   ① 每一条都小（字符串掐 200 字、最多 12 个键）——任务 JSON 是要给人看的，
 *      不能因为某次 run_shell 贴了 200KB 输出就肿起来；
 *   ② 密钥字段不落盘（只看字段名，不做模式匹配——模式匹配的次数
 *      和深度都很贵，而这里每条都很短）。
 *
 * 放在 redact.cjs 而不是 task.cjs：「别把密钥写进文件」的规矩应该只有一处。
 *
 * @param {Record<string, unknown>} args
 * @returns {Record<string, unknown>}
 */
function scrubLight(args) {
  const out = {}
  for (const [key, value] of Object.entries(args ?? {}).slice(0, 12)) {
    /* 比 SECRET_KEY 宽一档：这里宁可多打一条码 —— 台账是落盘的 */
    if (/(key|token|secret|password)/i.test(key)) {
      out[key] = PLACEHOLDER
      continue
    }
    out[key] = typeof value === 'string' ? value.slice(0, 200) : value
  }
  return out
}

module.exports = {
  PLACEHOLDER,
  redact,
  scrub,
  scrubLight,
  remember,
  forget,
  forgetAll,
  isSecretKey,
  looksSecret,
  knownCount: () => known.size,
}
