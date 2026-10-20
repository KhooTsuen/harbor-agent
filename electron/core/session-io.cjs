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
const { writeAtomic, keepCorruptCopy } = require('./safe-write.cjs')
const { sealLine, openLineDetailed } = require('./session-crypto.cjs')
const slot = require('./session-meta-slot.cjs')
/* 「改首行」的三条路径在那边（这里贴过 300 行红线） */
const metaWrite = require('./session-meta-write.cjs')

const MAX_TITLE = 60

/**
 * 会话首行的**唯一写法**：序列化（脱敏 + 封印）后补到定宽槽位。
 *
 * 补宽度是为了让「改 meta」能原地覆盖 4KB、不必碰整个文件 —— 见
 * `session-meta-slot.cjs` 开头的实测数字。这里只负责把两件事串起来，
 * 不另立第二套序列化口径。
 */
function metaLine(meta) {
  return slot.padToSlot(serializeLine(meta))
}

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

/** 已经留过档的会话文件（进程内去重）—— `list()` 每列一次会话就读一遍，不去重会刷一地 `.corrupt-*` */
const corruptKept = new Set()

/** 整篇损坏时留一份证据；同一份文件只留一次，**绝不删 / 覆盖原件** */
function keepCorruptOnce(id, file, broken) {
  if (corruptKept.has(file)) return
  corruptKept.add(file)
  const kept = keepCorruptCopy(file)
  log.error(
    `会话 ${id} 整篇读不出来（${broken} 行全解不开）${kept ? `，已留档 ${kept}` : '，留档也失败了'}`,
  )
}

/**
 * 逐行读。
 *
 * 每行先解封（明文行原样返回，所以**老数据和迁移中途照样能读**）。
 * 解不开的行**跳过并计数** —— 一行坏了不能让整个会话读不出来，这是加密
 * 之后唯一新增的失败模式，也是它必须被容错的原因。
 *
 * ★ 「文件不在」与「读不出来 / 整篇坏了」必须分开（与 task-io / changeset 同一口径）：
 *   · 文件不在（ENOENT）= 正常（还没建过 / 刚删）→ 静默空数组；
 *   · 别的读错（权限 / 设备）= 出声，不能当成「空会话」把用户吓一跳；
 *   · 整篇一行都解不开 = 文件级损坏 → 留一份 `.corrupt` 证据 + error 日志，
 *     否则它在 `list()` 里被 `lines.length === 0` 悄悄跳过，用户只看到会话「没了」。
 */
function readLines(id) {
  const file = fileFor(id)
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') log.error(`读会话失败（${id}）：${error?.message ?? error}`)
    return []
  }
  const out = []
  let broken = 0
  let seen = 0
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    seen += 1
    const opened = openLineDetailed(line)
    if (!opened.ok) {
      broken += 1
      continue
    }
    try {
      out.push(JSON.parse(opened.text))
    } catch {
      broken += 1 /* 半行 / 损坏行：跳过并计数（以前这里不计数，等于漏报坏行） */
    }
  }
  if (broken > 0) {
    log.warn(`会话 ${id} 有 ${broken} 行解不开（换了 Windows 账户或 data/ 换机器就会出现），已跳过`)
    if (out.length === 0 && seen > 0) keepCorruptOnce(id, file, broken)
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
  /*
   * ★ 这里**只脱敏一次** —— `scrubStorage` 已经递归处理了对象里的每个字符串值
   *   （见 redact.cjs 的 walkStorage：字符串叶子都过了一遍 redact）。
   *
   *   曾经写成 `redact(JSON.stringify(scrubStorage(line)))`：第二道 `redact` 作用在
   *   **已序列化的 JSON 文本**上，而它的「显式字段」正则会把 `\"` 里的反斜杠一起吃掉
   *   （值字符类没排除 `\`），于是那个 `"` 把 JSON 字符串提前闭合 → 整行报废。
   *   真机代价：一条会话里 39 行回复记录变成解析失败，读回时全被丢掉、只剩 partial
   *   快照 → 界面显示「这条回复没写完」，而内容其实写下去了。
   *   口径由自检 `31-session-redact` 的「落盘后仍是合法 JSON」钉住。
   */
  return sealLine(JSON.stringify(scrubStorage(line)))
}

/*
 * 整篇写（新建会话时写那行 meta 走这里）。
 *
 * ★ 走**原子写**：`fs.writeFileSync` 是「先截断、再写」——写到一半崩溃 / 磁盘满，
 *   用户刚建的会话就只剩半行 meta。用内核唯一那份文本原子写（`safe-write.writeAtomic`），
 *   与 task-io / credentials / changeset 同一套共用件。写失败**向调用方抛**，不吞。
 * ★ 写成功后清掉「这份文件已留过档」的标记 —— 内容整个换了，旧标记不再代表它。
 */
function writeLines(id, lines) {
  fs.mkdirSync(DIRS.sessions, { recursive: true })
  /* 首行是 meta 时补到定宽槽位：以后改模型只需原地覆盖那 4KB（见 session-meta-slot.cjs）。
     其余行照旧 —— 只有首行需要这个性质。 */
  const text = `${lines.map((line, index) => (index === 0 && line?.type === 'meta' ? metaLine(line) : serializeLine(line))).join('\n')}\n`
  const file = fileFor(id)
  writeAtomic(file, text)
  corruptKept.delete(file)
}

/**
 * 只改第一行（meta）。实现在 `session-meta-write.cjs`（本文件贴过 300 行红线）。
 *
 * 这里只做「id → 路径」的校验与收尾标记清理，并把**唯一序列化入口**
 * `serializeLine` 传进去 —— 脱敏 / 封印的口径不搬家，只搬落盘策略。
 */
function writeMetaLine(id, meta) {
  const file = fileFor(id)
  return metaWrite.writeMetaLine(file, metaLine(meta), () => corruptKept.delete(file), serializeLine)
}

module.exports = {
  fileFor,
  isSessionId,
  newId,
  safeTitle,
  /* 首行序列化入口：自检要钉「槽位宽度按字节算」，必须有处可取 */
  metaLine,
  readLines,
  writeLines,
  writeMetaLine,
  serializeLine,
  MAX_TITLE,
}
