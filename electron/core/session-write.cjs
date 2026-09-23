/**
 * 会话存储：写
 *
 * 从 session.cjs 拆出来的（那边过 300 行了）。
 * 文件格式与按行读写见 session-io.cjs；读取见 session-read.cjs。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
const { fileFor, newId, safeTitle, readLines, writeLines, serializeLine } = require('./session-io.cjs')

function create({
  title = '新对话',
  mode = 'pair',
  model = '',
  workdir = '',
  reasoning,
  threadSettings,
} = {}) {
  const id = newId()
  const dir = typeof workdir === 'string' ? workdir : ''
  /*
   * 属于哪个项目（一等实体，见 projects.cjs）。
   *
   * ★ 这里写进去之后，**项目就是显式的**，不再靠 workdir 现推。
   *   `ensureFor` 保证登记项一定在（不存在就按目录建一条），并且**不会覆盖**
   *   用户改过的名字/颜色 —— 它每次新建会话都会被调，顺手重置名字就白改了。
   *   没有工作目录的会话（纯聊天）没有项目，projectId 留空。
   */
  let projectId = ''
  if (dir) {
    try {
      projectId = require('./projects.cjs').ensureFor(dir)?.id ?? ''
    } catch (error) {
      /* 登记失败不该让「新建对话」失败 —— 但也不能一声不吭 */
      log.warn(`登记项目失败（会话照常创建）：${error instanceof Error ? error.message : error}`)
    }
  }

  const meta = {
    type: 'meta',
    id,
    title: safeTitle(title),
    mode,
    model,
    /* 思考强度档位（low / high / max）—— 和 mode/model 一样随会话落盘 */
    ...(reasoning ? { reasoning: String(reasoning) } : {}),
    /*
     * 会话属于哪个工作目录。侧栏按它分组 —— 换了目录就只看那个目录的会话，
     * 否则一堆不相干的对话混在一起没法找。
     */
    workdir: dir,
    ...(projectId ? { projectId } : {}),
    ...(threadSettings && typeof threadSettings === 'object' ? { threadSettings } : {}),
    createdAt: Date.now(),
  }
  writeLines(id, [meta])
  return meta
}

/** 追加一条 JSONL 事件；和整体重写共用 session-io 的唯一序列化入口。 */
function appendEvent(file, event) {
  fs.appendFileSync(file, `${serializeLine(event)}\n`, 'utf8')
}

function appendState(id, state) {
  const file = fileFor(id)
  if (!fs.existsSync(file)) return { ok: false, error: '会话不存在' }
  appendEvent(file, { type: 'conversation_state', state, ts: Date.now() })
  return { ok: true }
}

function append(id, message) {
  const file = fileFor(id)
  if (!fs.existsSync(file)) {
    writeLines(id, [
      { type: 'meta', id, title: '新对话', mode: 'pair', model: '', createdAt: Date.now() },
    ])
  }
  appendEvent(file, { type: 'message', ...message })
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
  appendEvent(file, {
    type: 'compact',
    summary: String(summary),
    upTo: Number(upTo) || 0,
    ts: Date.now(),
  })
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
  /* 思考强度档位（low/high/max）—— 以前不在白名单里，所以选了也存不下来 */
  if (patch.reasoning !== undefined) meta.reasoning = String(patch.reasoning)
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
}
