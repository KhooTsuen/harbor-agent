/**
 * 会话存储：文件原语
 *
 * 会话格式：一个会话一个 .jsonl 文件，**追加式**写。
 *   · 第一行永远是 meta（标题/时间/模式/模型）
 *   · 之后每行一条事件（消息、工具调用、压缩点、会话状态）
 *
 * 为什么用 JSONL 而不是一个大 JSON：
 *   · 追加就是 append，不用整篇重写（长对话不会越写越慢）
 *   · 中途崩了只丢最后一行，前面的还能读
 *   · 出问题时可以直接用文本编辑器看
 *
 * 这一个文件只管「文件在哪、怎么按行读写」。
 * 读会话在 session-read.cjs，写会话在 session-write.cjs。
 *
 * 可选加密见 session-crypto.cjs：**逐行**封印（`e1:` 前缀），所以上面那三个
 * 好处一个都没丢 —— 追加仍然是追加，坏的只是某一行。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
const { redact, scrubStorage } = require('./redact.cjs')
const { writeAtomic } = require('./safe-write.cjs')
const { sealLine, openLineDetailed } = require('./session-crypto.cjs')

const MAX_TITLE = 60

/**
 * 会话 id 的白名单：`sess_` + 小写字母数字 —— `newId()` 就是照这个造的。
 *
 * ⚠️ 为什么必须卡（审计问题 15）：`fileFor(id)` 以前直接把 id 拼进路径，
 * 而 id 是从渲染层传进来的（`session:read` / `session:update` / `session:delete` …）。
 * 传 `..\..\config` 就能读写**任意文件**。这几个通道共用同一个 `fileFor`，
 * 所以堵在这一处 = 一次堵住全部通道。
 *
 * 卡死就抛错，不「悄悄换成安全路径」：id 不合法说明调用方有 bug、或者有人在
 * 攻击，两种情况都该响一声，不该装作没事。
 */
const SESSION_ID_RE = /^sess_[a-z0-9]+$/

/** 文件名（去掉 .jsonl）是不是我们自己的会话 id —— `session-read.list()` 逐文件扫时要用 */
function isSessionId(id) {
  return SESSION_ID_RE.test(String(id ?? ''))
}

function fileFor(id) {
  const text = String(id ?? '')
  if (!isSessionId(text)) {
    throw new Error(`会话 id 不合法（只接受 sess_ 开头的小写字母数字）：${text.slice(0, 60)}`)
  }
  return path.join(DIRS.sessions, `${text}.jsonl`)
}

function newId() {
  const stamp = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 7)
  return `sess_${stamp}${rand}`
}

function safeTitle(input) {
  const text = String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return '新对话'
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1)}…` : text
}

/**
 * 逐行读。
 *
 * 每行先解封（明文行原样返回，所以**老数据和迁移中途照样能读**）。
 * 解不开的行**跳过并计数** —— 一行坏了不能让整个会话读不出来，这是加密
 * 之后唯一新增的失败模式，也是它必须被容错的原因。
 */
function readLines(id) {
  const file = fileFor(id)
  if (!fs.existsSync(file)) return []
  const out = []
  let broken = 0
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const opened = openLineDetailed(line)
    if (!opened.ok) {
      broken += 1
      continue
    }
    try {
      out.push(JSON.parse(opened.text))
    } catch {
      /* 半行 / 损坏行：跳过 */
    }
  }
  if (broken > 0) {
    log.warn(`会话 ${id} 有 ${broken} 行解不开（换了 Windows 账户或 data/ 换机器就会出现），已跳过`)
  }
  return out
}

/**
 * 会话 JSONL 的**唯一序列化入口**。
 *
 * 先按字段递归脱敏，再对最终文本兜一遍模式脱敏：前者能认出
 * `{ apiKey: '...' }` 这种敏感字段，后者兜住藏在普通文本里的 Bearer / JWT。
 * 最后才封印 —— **顺序不能反**：先加密的话那道字段/模式脱敏就看不见内容了。
 * 追加与整体重写必须都走这里，否则改标题时可能把旧密钥原样写回去。
 */
function serializeLine(line) {
  return sealLine(redact(JSON.stringify(scrubStorage(line))))
}

function writeLines(id, lines) {
  fs.mkdirSync(DIRS.sessions, { recursive: true })
  const text = `${lines.map(serializeLine).join('\n')}\n`
  fs.writeFileSync(fileFor(id), text, 'utf8')
}

/**
 * 只改**第一行**（meta），其余字节原样保留。
 *
 * 为什么不是「整篇读出来再整篇写回去」（2026-10-04 改的）：
 *   · `readLines()` 为了容错会**跳过解不开的行**（换了 Windows 账户 / data 换机器就会遇到）——
 *     拿它的结果写回去，那些行就被永久删了，而用户只是在改标题；
 *   · 长会话（数 MB）整篇重写期间崩溃 / 断电会截断文件，截断点之后的内容全没；
 *     追加式写「崩了只丢最后一行」的保证在这里失效。
 *
 * 所以：第一行是 meta 就换掉它；不是 meta（或第一行本身就解不开）就把新 meta 插到最前面。
 * 两种情况都**不读也不写其余行**，并用原子写落盘。
 *
 * @returns {{ ok: boolean, replaced?: boolean, error?: string }}
 */
function writeMetaLine(id, meta) {
  const file = fileFor(id)
  if (!fs.existsSync(file)) return { ok: false, error: '会话不存在' }
  const raw = fs.readFileSync(file, 'utf8')
  const cut = raw.indexOf('\n')
  const firstRaw = cut >= 0 ? raw.slice(0, cut) : raw
  const rest = cut >= 0 ? raw.slice(cut + 1) : ''
  const head = openLineDetailed(firstRaw.trim())
  let isMeta = false
  if (head.ok) {
    try {
      isMeta = JSON.parse(head.text).type === 'meta'
    } catch {
      isMeta = false
    }
  }
  /* 第一行是 meta 就换掉它，否则把新 meta 插到最前面 —— 两种情况其余内容都不参与重排 */
  const keep = isMeta ? rest : raw
  /*
   * 例外（唯一一处会动其它行的地方）：**旧文件里还留着明文密钥**时顺手清一遍。
   * 这条保证以前是「整篇重写」白送的（自检 `31-session-redact` 钉着），
   * 改成只换第一行之后必须显式做，否则等于把脱敏能力悄悄丢了。
   * 只在真检测到才扫（`redact()` 与原文不同），平时零开销。
   */
  const body = redact(keep) === keep ? keep : rescrubLines(keep)
  writeAtomic(file, `${serializeLine(meta)}\n${body}`)
  return { ok: true, replaced: isMeta }
}

/**
 * 逐行重新脱敏：能解析的行过一遍唯一序列化入口，**解不开的行原样保留**。
 *
 * 与「整篇读→整篇写」的区别：坏行不会被丢掉（问题 22 的另一半），
 * 且落盘走原子写 —— 清旧密钥的同时不引入「写一半截断」的风险。
 */
function rescrubLines(text) {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      const opened = openLineDetailed(trimmed)
      if (!opened.ok) return line
      try {
        return serializeLine(JSON.parse(opened.text))
      } catch {
        return line
      }
    })
    .join('\n')
}

module.exports = {
  fileFor,
  isSessionId,
  newId,
  safeTitle,
  readLines,
  writeLines,
  writeMetaLine,
  serializeLine,
  MAX_TITLE,
}
