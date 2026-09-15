/**
 * 会话存储：写
 *
 * 从 session.cjs 拆出来的（那边过 300 行了）。
 * 文件格式与按行读写见 session-io.cjs；读取见 session-read.cjs。
 */

const fs = require('node:fs')
const path = require('node:path')
const { redact: redactLine, scrub } = require('./redact.cjs')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
const { fileFor, newId, safeTitle, readLines, writeLines } = require('./session-io.cjs')

function create({
  title = '新对话',
  mode = 'pair',
  model = '',
  workdir = '',
  threadSettings,
} = {}) {
  const id = newId()
  const meta = {
    type: 'meta',
    id,
    title: safeTitle(title),
    mode,
    model,
    /*
     * 会话属于哪个工作目录。侧栏按它分组 —— 换了目录就只看那个目录的会话，
     * 否则一堆不相干的对话混在一起没法找。
     */
    workdir: typeof workdir === 'string' ? workdir : '',
    ...(threadSettings && typeof threadSettings === 'object' ? { threadSettings } : {}),
    createdAt: Date.now(),
  }
  writeLines(id, [meta])
  return meta
}

function appendState(id, state) {
  const file = fileFor(id)
  if (!fs.existsSync(file)) return { ok: false, error: '会话不存在' }
  fs.appendFileSync(
    file,
    `${JSON.stringify({ type: 'conversation_state', state, ts: Date.now() })}
`,
    'utf8',
  )
  return { ok: true }
}

/**
 * 落盘前统一脱敏。
 *
 * 会话里出现密钥的路径不止一条：模型可能把 key 写进代码、
 * 工具参数里可能带着 env、报错信息可能回显整条 URL。
 * 在**唯一的写入口**过一遍，比在每个调用点记得处理可靠。
 */
function scrubLine(line) {
  return scrub(redactLine(line))
}

function append(id, message) {
  const file = fileFor(id)
  if (!fs.existsSync(file)) {
    writeLines(id, [
      { type: 'meta', id, title: '新对话', mode: 'pair', model: '', createdAt: Date.now() },
    ])
  }
  fs.appendFileSync(
    file,
    `${JSON.stringify({ type: 'message', ...message })}
`,
    'utf8',
  )
  return { ok: true }
}

/**
 * 记一个压缩点。
 *
 * @param {string} id
 * @param {string} summary 摘要文本
 * @param {number} upTo 摘要覆盖到第几条消息（消息数组下标 + 1）
 */
function appendCompact(id, summary, upTo) {
  const file = fileFor(id)
  if (!fs.existsSync(file)) return { ok: false, error: '会话不存在' }
  fs.appendFileSync(
    file,
    `${JSON.stringify({ type: 'compact', summary: String(summary), upTo: Number(upTo) || 0, ts: Date.now() })}
`,
    'utf8',
  )
  log.info(`压缩会话 ${id}（覆盖前 ${upTo} 条）`)
  return { ok: true }
}

/**
 * 改 meta。
 * meta 在第一行，改它要整体重写 —— 会话不大时这点开销可以接受。
 */
function updateMeta(id, patch) {
  const lines = readLines(id)
  if (lines.length === 0) return null

  let meta = lines.find((l) => l.type === 'meta')
  if (!meta) {
    meta = { type: 'meta', id, title: '新对话', mode: 'pair', model: '', createdAt: Date.now() }
    lines.unshift(meta)
  }

  if (patch.title !== undefined) meta.title = safeTitle(patch.title)
  if (patch.mode !== undefined) meta.mode = String(patch.mode)
  if (patch.model !== undefined) meta.model = String(patch.model)
  if (patch.workdir !== undefined) meta.workdir = String(patch.workdir)
  if (patch.threadSettings !== undefined) meta.threadSettings = patch.threadSettings

  writeLines(id, lines)
  return meta
}

function remove(id) {
  const file = fileFor(id)
  if (fs.existsSync(file)) fs.rmSync(file, { force: true })
  return { ok: true }
}

function removeAll() {
  if (!fs.existsSync(DIRS.sessions)) return { ok: true, count: 0 }
  let count = 0
  for (const name of fs.readdirSync(DIRS.sessions)) {
    if (!name.endsWith('.jsonl')) continue
    fs.rmSync(path.join(DIRS.sessions, name), { force: true })
    count += 1
  }
  return { ok: true, count }
}

/**
 * 批量导入线程：每条写成一个新的 jsonl 文件。
 *
 * 返回**带新 id** 的线程数组（新 id 来自文件名），调用方要用返回值更新界面，
 * 否则 store 里的 id 和磁盘上的对不上，点开就读不到。
 */
function importThreads(threadList) {
  const imported = []

  for (const thread of threadList) {
    if (!thread || typeof thread !== 'object') continue

    const meta = create({
      title: typeof thread.title === 'string' ? thread.title : '导入的对话',
      mode: typeof thread.mode === 'string' ? thread.mode : 'pair',
      model: typeof thread.model === 'string' ? thread.model : '',
    })

    const list = Array.isArray(thread.messages) ? thread.messages : []
    for (const message of list) {
      if (!message || typeof message !== 'object') continue
      if (typeof message.content !== 'string') continue
      append(meta.id, {
        role: typeof message.role === 'string' ? message.role : 'user',
        content: message.content,
        ts: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        ...(message.toolRuns ? { toolRuns: message.toolRuns } : {}),
        ...(message.errorText ? { error: message.errorText } : {}),
      })
    }

    imported.push({ ...thread, id: meta.id, projectId: thread.projectId ?? 'imported' })
  }

  log.info(`导入 ${imported.length} 条对话`)
  return imported
}

module.exports = {
  create,
  append,
  appendCompact,
  appendState,
  updateMeta,
  remove,
  removeAll,
  importThreads,
  scrubLine,
}
