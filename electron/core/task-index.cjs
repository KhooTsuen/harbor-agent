/**
 * 任务索引（AG-039 后台执行隔离）
 *
 * ── 为什么要有这个 ──
 * 主进程每次「刷新界面」都要列一遍任务：工具跑完一次、计划变了、窗口回到前台……
 * 而列任务原来是**把 data/tasks 下每个 JSON 全读一遍**。实测 1241 个任务：
 * `readdir 3ms + stat 97ms + 解析 167ms`，合计 240ms 上下。
 * 也就是说：**Agent 干得越多，主进程被按住越久** —— 渲染层的 IPC、
 * 窗口事件、托盘菜单全排在这 240ms 后面。这正是 AG-039 说的
 * 「后台执行不得阻塞 Renderer」在实现层面最实在的一处。
 *
 * ── 做法：谁写谁更新 ──
 * 所有写都经过 `task-io.write`（这个项目里没有第二个地方动任务文件），
 * 所以写完顺手更新索引即可，**列任务时不必再碰每个文件**。
 *
 * ── 坏了怎么办 ──
 * 索引只是**加速**，不是真相源：真相仍然是那些 JSON 文件。
 * 目录里的文件数和索引对不上（外面动过、老数据、手动删过）就整体重建一次，
 * 重建就是老老实实读一遍（慢，但只在需要时发生）。索引文件本身读坏了
 * 也走同一条路 —— 重建。
 */

const fs = require('node:fs')
const path = require('node:path')
const io = require('./task-io.cjs')
const log = require('./log.cjs')

const VERSION = 1

/** 内存里的那份（进程内共享，避免每次重读索引文件） */
let cache = null

function indexFile() {
  return path.join(io.root(), '_index.json')
}

/** 索引里只留界面要用的字段 —— 列任务时先按这些过滤，能少读一堆文件 */
function summaryOf(task) {
  return {
    id: task.id,
    updatedAt: task.updatedAt ?? 0,
    status: task.status ?? '',
    sessionId: task.sessionId ?? '',
    workdir: task.workdir ?? '',
    title: task.title ?? '',
  }
}

function emptyIndex() {
  return { version: VERSION, items: [] }
}

function readFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(), 'utf8'))
    if (raw?.version !== VERSION || !Array.isArray(raw.items)) return null
    return raw
  } catch {
    return null
  }
}

function writeFile(items) {
  try {
    fs.mkdirSync(io.root(), { recursive: true })
    fs.writeFileSync(indexFile(), JSON.stringify({ version: VERSION, items }, null, 0), 'utf8')
  } catch (error) {
    /* 索引写不进去不影响功能（下次重建）—— 但不能一声不吭 */
    log.warn(`写任务索引失败：${error instanceof Error ? error.message : error}`)
  }
}

/** 目录里的任务文件数（不含索引自己）；读不到就当空 */
function fileCount() {
  try {
    return fs
      .readdirSync(io.root())
      .filter((name) => name.endsWith('.json') && !name.startsWith('_')).length
  } catch {
    return 0
  }
}

/**
 * 重建：老老实实读一遍所有任务（慢路径）。
 * 只在「索引不可用」或「文件数对不上」时走这里。
 */
function rebuild() {
  const items = []
  for (const id of io.ids()) {
    const task = io.get(id)
    if (task) items.push(summaryOf(task))
  }
  writeFile(items)
  cache = { version: VERSION, items, count: items.length }
  return cache
}

/**
 * 拿索引但**不校验目录**（写路径用）。
 *
 * ★ 这里有个坑值得写下来：如果 `update()` 也走带校验的 `load()`，
 *   那么「刚写完文件 → 目录里多了一个 → 索引里还没有 → 校验不通过」
 *   就会让**每一次写入都触发一次全量重建**（读一千个文件）——
 *   比不建索引还慢。写路径本来就知道自己刚干了什么，不需要校验。
 */
function ensure() {
  if (cache) return cache
  const raw = readFile()
  if (!raw) return rebuild()
  cache = { version: VERSION, items: raw.items, count: raw.items.length }
  return cache
}

/**
 * 拿到索引（必要时重建）——**读路径用**。
 *
 * 校验很便宜：一次 `readdir` 数个数（3ms）—— 比逐文件 stat（97ms）便宜得多，
 * 而且外部改动（多一个文件 / 少一个文件）一定会被它发现。
 */
function load() {
  if (cache && cache.count === fileCount()) return cache
  const raw = readFile()
  const count = fileCount()
  if (!raw || raw.items.length !== count || raw.items.some((item) => !('workdir' in item))) return rebuild()
  cache = { version: VERSION, items: raw.items, count }
  return cache
}

/** 写完一条任务顺手更新（O(n) 但 n 是内存数组，几微秒） */
function update(task) {
  const index = ensure()
  const summary = summaryOf(task)
  const at = index.items.findIndex((item) => item.id === summary.id)
  if (at >= 0) index.items[at] = summary
  else index.items.push(summary)
  writeFile(index.items)
  /* 新增的那条对应的文件是调用方刚写完的，所以 +1 是准的 —— 不用再去 readdir */
  cache = { ...index, items: index.items, count: index.items.length }
  return summary
}

function remove(id) {
  const index = ensure()
  const next = index.items.filter((item) => item.id !== String(id))
  if (next.length === index.items.length) return false
  writeFile(next)
  /* 少了一个文件 —— count 跟着减，免得下一次 load 白白重建 */
  cache = { ...index, items: next, count: next.length }
  return true
}

/**
 * 列任务：按 `updatedAt` 新→旧，可按状态 / 会话过滤。
 *
 * 返回的是**磁盘上的任务本体**（界面要 steps / plan / changedFiles），
 * 所以还是要逐个读文件；但**只读真正要返回的那些**，不再全表通读。
 */
function list({ limit = 50, status = '', statuses = null, sessionId = '', workdir = '' } = {}) {
  const index = load()
  const allowed = Array.isArray(statuses) && statuses.length > 0 ? new Set(statuses) : null
  const matched = index.items
    .filter((item) => (allowed ? allowed.has(item.status) : true))
    .filter((item) => (status ? item.status === status : true))
    .filter((item) => (sessionId ? item.sessionId === sessionId : true))
    .filter((item) => (workdir ? item.workdir === workdir : true))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, Math.max(0, limit))

  const out = []
  for (const item of matched) {
    const task = io.get(item.id)
    /* 索引里有、文件没了（外面删过）→ 跳过并在下次 load 时重建 */
    if (task) out.push(task)
  }
  return out
}

/** 只给测试和诊断用：把内存里的那份扔掉，下次强制重读 */
function reset() {
  cache = null
}

module.exports = { load, ensure, list, update, remove, rebuild, reset, indexFile, VERSION }
