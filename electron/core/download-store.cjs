/**
 * 下载任务台账：落盘 `data/downloads.json`
 *
 * 形状：`{ version: 1, limits: {...}, items: [...] }`（带 version，将来加字段好迁移）
 *
 * 三个刻意的决定：
 *
 * ① **写盘用原子替换**（`safe-write.writeAtomic`）。下载是后台在跑的，正好在写盘
 *    那一刻被杀 / 关机，一个半截 JSON 会让整份台账读不出来（所有任务在一个文件里，
 *    写坏是**全丢**）。这一点和 `schedule-store.cjs` 同源。
 *
 * ② **运行态不落盘**。`received` / `speedBps` / `attempts` 是**这一进程**的事实，
 *    进程一停就不该假装还在跑 —— 重启后所有 `running` / `queued` 一律回落成
 *    `paused`（见 `settle()`，**启动时调一次**，不是每次读盘都回落）。
 *    落一个假的「运行中」比落一个诚实的「已暂停」更坑。
 *
 * ③ **限速配置存活在同一份文件里**（`limits`）。它属于「下载」这一个功能，
 *    单独再开一份设置文件是第二个真相源。
 *
 * 测试怎么不碰真实数据：`setFilePathForTest()` 把路径指到别处（名字就写清楚了
 * 它是给测试用的，别在业务代码里调）。
 *
 * ⚠️ **URL 原样存**（含查询串）。签过名的下载地址（S3/OSS 预签名）查询串里就是
 * 临时凭据，但**去掉就没法重试 / 续传** —— 所以这里不脱敏。代价是：这份台账在
 * `data/` 下，会跟着用户拷 data/ 走。因此**日志里绝不打印 URL**（只打印文件名）。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
const { writeAtomic } = require('./safe-write.cjs')

const VERSION = 1

/** 只认这几档状态。别的（含旧版残留）一律当 queued */
const STATUSES = ['queued', 'running', 'paused', 'done', 'failed']

/** patch() 认得、且可以落盘的字段 */
const FIELDS = [
  'total', 'received', 'status', 'error', 'updatedAt',
  'finishedAt', 'connections', 'attempts', 'resumedFrom', 'speedBps',
]

/** 并发上限与限速的默认值（内核是真相源，界面只显示） */
const DEFAULT_LIMITS = { maxConcurrent: 2, maxKBps: 0, connections: 4 }

/** 测试注入的路径；空串 = 用真实路径 */
let overridePath = ''

function filePath() {
  return overridePath || path.join(DIRS.data, 'downloads.json')
}

/** 把台账指到别的文件（**只给测试用**）。传空串还原 */
function setFilePathForTest(target) {
  overridePath = typeof target === 'string' ? target : ''
  return filePath()
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function empty() {
  return { version: VERSION, limits: { ...DEFAULT_LIMITS }, items: [] }
}

function normalizeStatus(value) {
  return STATUSES.includes(value) ? value : 'queued'
}

function numberOr(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'))
    /* 只收「id + file 都可用」的：缺 file 的旧记录（早期草稿的 path 形状）会在界面上变成幽灵行 */
    const usable = (item) => Boolean(item) && typeof item.id === 'string' && item.id && typeof item.file === 'string' && item.file
    const items = Array.isArray(parsed.items)
      ? parsed.items.filter(usable).map((item) => ({
          ...item,
          status: normalizeStatus(item.status),
          /* 旧记录没有 origin —— 一律当「手动加的」（迁移只补默认值，不动旧数据） */
          origin: item.origin === 'browser' ? 'browser' : 'user',
        }))
      : []
    if (Array.isArray(parsed.items) && items.length !== parsed.items.length) {
      log.warn(`下载台账里有 ${parsed.items.length - items.length} 条缺 id / file，已丢弃`)
    }
    const limits = { ...DEFAULT_LIMITS, ...(parsed.limits && typeof parsed.limits === 'object' ? parsed.limits : {}) }
    return { version: VERSION, limits, items }
  } catch (error) {
    /* 文件还不存在是正常的（一个任务都没建过）；别的错得让人看见 */
    if (error?.code !== 'ENOENT') log.warn(`读下载台账失败：${messageOf(error)}`)
    return empty()
  }
}

function persist(data) {
  const target = filePath()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  writeAtomic(target, JSON.stringify(data, null, 2))
}

/** 给调用方的是副本：外面改了不该影响内存/文件里的那份 */
function clone(item) {
  return { ...item }
}

function newId() {
  return `dl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function list() {
  return load()
    .items.slice()
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || (a.id < b.id ? -1 : 1))
    .map(clone)
}

function get(id) {
  const item = load().items.find((entry) => entry.id === id)
  return item ? clone(item) : null
}

function getLimits() {
  return { ...load().limits }
}

function setLimits(patch = {}) {
  const store = load()
  const next = { ...store.limits }
  if (patch.maxConcurrent !== undefined) {
    const n = Number(patch.maxConcurrent)
    next.maxConcurrent = Number.isFinite(n) ? Math.min(8, Math.max(1, Math.floor(n))) : next.maxConcurrent
  }
  if (patch.maxKBps !== undefined) {
    const n = Number(patch.maxKBps)
    next.maxKBps = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  if (patch.connections !== undefined) {
    const n = Number(patch.connections)
    next.connections = Number.isFinite(n) ? Math.min(16, Math.max(1, Math.floor(n))) : next.connections
  }
  store.limits = next
  try {
    persist(store)
  } catch (error) {
    return { ok: false, error: `保存失败：${messageOf(error)}` }
  }
  return { ok: true, limits: { ...next } }
}

/**
 * 新建一条。`file` 是**最终产物**的绝对路径；`.part` / `.part.json` 由引擎在旁边管。
 * @returns {{ ok: boolean, item?: object, error?: string }}
 */
function add(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const url = String(raw.url ?? '').trim()
  const file = String(raw.file ?? '').trim()
  if (!url) return { ok: false, error: '地址不能为空' }
  if (!file) return { ok: false, error: '保存路径不能为空' }

  const store = load()
  /* 同一个目标文件不允许两条任务同时写（会互相覆盖） */
  const clash = store.items.find(
    (entry) => entry.file === file && entry.status !== 'done' && entry.status !== 'failed',
  )
  if (clash) return { ok: false, error: '这个保存路径已经有一条没跑完的下载了' }

  const now = Date.now()
  const item = {
    id: newId(),
    url,
    file,
    name: path.basename(file),
    /* 来源：'browser' = 网页里点的（见 download-intake.cjs）；'user' = 手填地址加的 */
    origin: raw.origin === 'browser' ? 'browser' : 'user',
    total: numberOr(raw.total, 0),
    received: 0,
    status: 'queued',
    error: '',
    createdAt: now,
    updatedAt: now,
    finishedAt: 0,
    connections: 0,
    attempts: 0,
    resumedFrom: 0,
    speedBps: 0,
  }
  store.items.push(item)
  try {
    persist(store)
  } catch (error) {
    return { ok: false, error: `保存失败：${messageOf(error)}` }
  }
  return { ok: true, item: clone(item) }
}

/** 改一条（只认 FIELDS）。不存在返回 null */
function patch(id, fields = {}) {
  const store = load()
  const index = store.items.findIndex((entry) => entry.id === id)
  if (index < 0) return null
  const item = { ...store.items[index] }
  for (const key of FIELDS) {
    if (!(key in fields)) continue
    if (key === 'status') item.status = normalizeStatus(fields.status)
    else if (key === 'error') item.error = String(fields.error ?? '')
    else item[key] = numberOr(fields[key], item[key] ?? 0)
  }
  item.updatedAt = numberOr(fields.updatedAt, Date.now())
  store.items[index] = item
  try {
    persist(store)
  } catch (error) {
    log.warn(`写下载台账失败（${item.name}）：${messageOf(error)}`)
  }
  return clone(item)
}

function remove(id) {
  const store = load()
  const items = store.items.filter((entry) => entry.id !== id)
  if (items.length === store.items.length) return { ok: false, error: '没有这条下载任务' }
  store.items = items
  try {
    persist(store)
  } catch (error) {
    return { ok: false, error: `删除失败：${messageOf(error)}` }
  }
  return { ok: true }
}

/** 清掉已结束（done / failed）的条目，返回清掉的条数 */
function clearFinished() {
  const store = load()
  const before = store.items.length
  store.items = store.items.filter((entry) => entry.status !== 'done' && entry.status !== 'failed')
  const removed = before - store.items.length
  if (removed > 0) {
    try {
      persist(store)
    } catch (error) {
      return { ok: false, error: `清理失败：${messageOf(error)}`, removed: 0 }
    }
  }
  return { ok: true, removed }
}

/**
 * **启动时调一次**：把上次进程留下的 `running` / `queued` 全部回落成 `paused`。
 * 只在启动调（由 `download-queue.attach()` 触发）—— 每次读盘都回落会把
 * 「刚加进来、正在排队」的任务也一并暂停（真踩过）。
 * @returns {number} 回落了几条
 */
function settle() {
  const store = load()
  let changed = 0
  store.items = store.items.map((item) => {
    if (item.status === 'running' || item.status === 'queued') {
      changed += 1
      return { ...item, status: 'paused', speedBps: 0 }
    }
    return item
  })
  if (changed > 0) {
    try {
      persist(store)
    } catch (error) {
      log.warn(`回落下载状态失败：${messageOf(error)}`)
    }
  }
  return changed
}

module.exports = {
  VERSION,
  STATUSES,
  DEFAULT_LIMITS,
  filePath,
  setFilePathForTest,
  list,
  get,
  getLimits,
  setLimits,
  add,
  patch,
  remove,
  clearFinished,
  settle,
}
