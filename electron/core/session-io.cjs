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
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const { redact, scrubStorage } = require('./redact.cjs')

const MAX_TITLE = 60

function fileFor(id) {
  return path.join(DIRS.sessions, `${id}.jsonl`)
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

function readLines(id) {
  const file = fileFor(id)
  if (!fs.existsSync(file)) return []
  const out = []
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* 半行 / 损坏行：跳过 */
    }
  }
  return out
}

/**
 * 会话 JSONL 的**唯一序列化入口**。
 *
 * 先按字段递归脱敏，再对最终文本兜一遍模式脱敏：前者能认出
 * `{ apiKey: '...' }` 这种敏感字段，后者兜住藏在普通文本里的 Bearer / JWT。
 * 追加与整体重写必须都走这里，否则改标题时可能把旧密钥原样写回去。
 */
function serializeLine(line) {
  return redact(JSON.stringify(scrubStorage(line)))
}

function writeLines(id, lines) {
  fs.mkdirSync(DIRS.sessions, { recursive: true })
  const text = `${lines.map(serializeLine).join('\n')}\n`
  fs.writeFileSync(fileFor(id), text, 'utf8')
}

module.exports = { fileFor, newId, safeTitle, readLines, writeLines, serializeLine, MAX_TITLE }
