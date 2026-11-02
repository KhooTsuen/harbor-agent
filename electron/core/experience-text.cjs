/**
 * 经验的「文本与特征」—— 观察原文怎么洗、目标 / 做法怎么认、触发特征长什么样
 *
 * 从 `experience-schema.cjs` 拆出来的（那个文件贴 300 行红线）。拆的边界是
 * **纯函数**：这里不读磁盘、不判状态，只把一次调用变成可比较的字段。
 * 状态机 / 阈值 / 风险档仍在 schema，两边互不反向依赖（schema → text 单向）。
 *
 * ── ★ 脱敏失败**不许**退回原文（2026-11-02 修，用户点出的反例 3）──
 *
 * 原来的写法是 `catch { safe = raw }`，理由是「脱敏自己挂了也不能连累经验层」。
 * 这条理由本身没错，错的是兜底方向：经验是要**注入提示**、也要**落盘**的东西，
 * 一旦脱敏这条链断了（抛异常 / 返回非字符串 / 打过码却还像密钥），
 * 退回原文等于把密钥原样写进 `data/experiences.json` 再送进模型上下文。
 * 现在的兜底是：**放弃这一条经验**，只留一句不含原文的诊断（`sanitize().error`）。
 */

const { tokens } = require('./memory-similarity.cjs')
const { domainOf } = require('./tool-failure.cjs')
const redact = require('./redact.cjs')

/** 一次观察原文最多留多少字（进库、进提示的都是这个长度） */
const MAX_TEXT = 240

/** 错误的名字 / 码（**不带 message** —— 它可能包着调用方传进来的原文） */
function errorName(error) {
  if (!error || typeof error !== 'object') return '非异常'
  return String(error.code || error.name || '异常')
}

/**
 * 观察原文 → 可落盘、可注入的安全文本。**先脱敏**再抹噪声再截断。
 *
 * 顺序不能反：脱敏函数认的是原文（先抹数字会把 `sk-...` 里的字符改掉，密钥就漏了）。
 *
 * @returns {{ ok: boolean, text: string, error: string }}
 *   `ok: false` 时 `text` 一定是空串 —— 调用方看到它就该整条不记，不许自己拼回去。
 */
function sanitize(text) {
  const raw = String(text ?? '')
  if (!raw) return { ok: true, text: '', error: '' }

  let safe
  try {
    safe = redact.redact(raw)
  } catch (error) {
    return { ok: false, text: '', error: `脱敏调用失败（${errorName(error)}）` }
  }
  if (typeof safe !== 'string') return { ok: false, text: '', error: '脱敏没有返回文本' }

  /* 打过码之后再查一遍：还像密钥，说明这条链漏了 —— 同样按失败处理 */
  try {
    if (redact.looksSecret(safe)) return { ok: false, text: '', error: '脱敏后仍像密钥' }
  } catch {
    return { ok: false, text: '', error: '脱敏结果无法复核' }
  }

  return {
    ok: true,
    /* 路径 / 命令里的数字也要抹（`a.txt` 与 `b.txt` 该像、`/item/123` 与 `/item/456` 该像） */
    text: safe
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.+-]+/g, '<时间>')
      .replace(/[0-9a-f]{8,}/gi, '<id>')
      .replace(/\d+/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TEXT),
    error: '',
  }
}

/** 归一化文本；脱敏失败时返回空串（**永不**返回原文） */
function normalizeText(text) {
  return sanitize(text).text
}

/**
 * 「同一个目标」—— 验证与反例都要求它相同，否则「随便一个成功」会被算成验证。
 *
 * 为什么按工具类型取不同字段（而不是留空）：留空就等于「同工具的任何成功都算」，
 * `npm test` 挂了之后随便跑个 `dir` 成功，那条经验就被「验证」了一次 —— 这是
 * 把巧合当证据，比不学更糟。
 */
function targetOf(tool, args) {
  const name = String(tool ?? '')
  const data = args ?? {}
  if (name === 'run_shell') {
    /* 命令首段（可执行文件 + 子命令的关键那一截），忽略后面的参数变化 */
    return String(data.command ?? '')
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join(' ')
      .toLowerCase()
  }
  if (/^(read_file|write_file|edit_file|list_dir|download)$/.test(name)) {
    return String(data.path ?? data.dir ?? '').replace(/\\/g, '/').toLowerCase()
  }
  if (/^browse|^edge_/.test(name)) {
    const url = String(data.url ?? '')
    const host = url.match(/^https?:\/\/([^/]+)/i)
    return host ? host[1].toLowerCase() : ''
  }
  return ''
}

/**
 * 「做法签名」—— 证明两次成功用的是**同一套做法**（`experience-verify` 之外的第二道闸）。
 *
 * 为什么不能只看「同工具同目标的成功」：文件后来自个儿出现了，同一个 `read_file`
 * 再读就成功了 —— 那不是「修法」，只是环境变了。真正能算验证的，是**同一种做法
 * 被重复采用**（同一命令 / 同一工具 / 同一站点的同一路径形状）。
 *
 * `target`（具体文件、具体 URL）**不进**这里：目标在 `feature.target` 里单独管，
 * 两者混在一起会让「换个文件」永远算不了验证，而跨文件复用恰恰是经验该干的事。
 */
function recipeOf(tool, args) {
  const name = String(tool ?? '')
  const data = args ?? {}
  if (!name) return ''
  if (name === 'run_shell') return `${name}|${normalizeText(data.command ?? '')}`
  if (/^browse|^edge_/.test(name)) {
    /* 站点 + 路径形状（数字抹平）：`/item/123` 与 `/item/456` 是同一种做法 */
    const url = String(data.url ?? '')
    const match = url.match(/^https?:\/\/([^/?#]+)([^?#]*)/i)
    if (!match) return name
    return `${name}|${match[1].toLowerCase()}|${normalizeText(match[2])}`
  }
  /* 文件类：做法 = 用哪个工具动它（`read_file` 与 `list_dir` 是两种做法） */
  return name
}

/**
 * 造一条「触发特征」—— 匹配、去重、验证都用它，**形状只有这一处**。
 *
 * `textSafe:false` = 观察原文脱敏失败，**这条特征不可用**：
 * 调用方（`experience-loop`）必须整条放弃，不许拿 `text` 拼一条凑合的记录。
 *
 * @param {{ tool?: string, failure?: object|null, text?: string, category?: string, args?: object|null }} input
 */
function featureOf({ tool = '', failure = null, text = '', category = '', args = null } = {}) {
  const categoryOf = String(category || failure?.category || 'tool_failure')
  const safe = sanitize(text)
  return {
    tool: String(tool ?? ''),
    domain: domainOf(tool), /* 领域按工具名推 —— 复用 tool-failure 那张表，不另写一份 */
    category: categoryOf,
    reasonCode: String(failure?.reasonCode ?? ''),
    target: targetOf(tool, args), /* 验证 / 反例都要求「同一个目标」，见 targetOf */
    /* 关键词只用来算相似度；不落成新的一套分词（memory-similarity 是唯一来源） */
    tokens: safe.ok ? [...tokens(safe.text)].slice(0, 120) : [],
    text: safe.text,
    /* ★ 脱敏失败时这里就是 false —— 上层据此放弃整条经验 */
    textSafe: safe.ok,
    textError: safe.ok ? '' : safe.error,
  }
}

module.exports = { MAX_TEXT, errorName, sanitize, normalizeText, targetOf, recipeOf, featureOf }
