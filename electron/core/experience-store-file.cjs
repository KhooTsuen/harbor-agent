/**
 * 经验库的**读与落盘**（`data/experiences.json`）：路径、加载、原子写、容量、注入账
 *
 * 三个写口（建条目 / 记验证 / 记反例）在 `experience-store-write.cjs` —— 那个文件
 * 贴 300 行红线后拆出来的，拆的边界是「读一次盘 / 写一次盘」的机制 vs「一次执行
 * 该怎么落成记录」的判据。`experience-store.cjs` 把两者合成一个对外门面。
 *
 * 三条纪律（记忆那边踩过，这里不重踩）：
 * ① **原子写**（`safe-write.writeAtomic`）：写一半崩了不能让用户丢一整份经验。
 * ② **解不开就另存一份再当空**（`keepCorruptCopy`）：否则下一次写盘把坏文件盖掉。
 * ③ **落盘前再扫一遍密钥**（`experience-guard.splitSafe`）：脱敏规则以后会加，
 *    但已经写进磁盘的明文不会自己消失 —— 宁可少存一条。
 */
const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
const { writeAtomic, keepCorruptCopy } = require('./safe-write.cjs')
const redact = require('./redact.cjs')
const schema = require('./experience-schema.cjs')
const guard = require('./experience-guard.cjs')

function filePath() {
  return path.join(DIRS.data, 'experiences.json')
}

/** 库还没建过（绝大多数会话从没踩过要学的东西）—— 成功路径靠它少读一次盘 */
function exists() {
  try {
    return fs.statSync(filePath()).size > 2
  } catch {
    return false
  }
}

/**
 * 读盘缓存：**只缓存原始文本**，每次仍然重新 `JSON.parse`。
 *
 * 为什么值得加：`observeRun` 每次工具调用都会读一次本文件（成功且库非空时），
 * 一次对话几十次工具调用就是几十次 `readFileSync` —— 而库最多 200 条、
 * 99% 的调用里它**一个字都没变**。真正的开销是「打开 + 读」这一次 IO，不是解析。
 *
 * 为什么缓存的是文本而不是解析后的对象：`load()` 的返回值会被调用方
 * **就地改**（`recordMove` 改 status / history，`persist` 再写盘）。
 * 缓存对象就等于把「某次调用的临时修改」泄漏进下一次读 —— 那是个只有
 * 崩溃之后才看得见的 bug。缓存文本则每次都是新对象，语义与不加缓存完全一致。
 *
 * 失效判据是 `mtimeMs:size` 两个一起比对：只看 mtime 会在「同一时间段内
 * 被换成同样大小」时漏掉（实测 NTFS 的 mtime 精度足够，但不值得赌）；
 * 只看 size 则同长度改写会漏。写盘时（`persist`）顺手把新文本塞进缓存 ——
 * 我们自己刚写的内容不需要再从盘上读回来。
 */
let cache = { key: '', raw: '' }

/** 真的发生了几次「打开并读文件」（自检用它证明缓存生效，别拿日志猜） */
let reads = 0

function readCount() {
  return reads
}

/** 读原始文本；文件不存在 / 读不动都返回 `null`（调用方按「空库」处理） */
function readRaw() {
  let stat
  try {
    stat = fs.statSync(filePath())
  } catch {
    cache = { key: '', raw: '' }
    return null
  }
  const key = `${stat.mtimeMs}:${stat.size}`
  if (cache.key === key && cache.raw) return cache.raw
  let raw = ''
  try {
    reads += 1
    raw = fs.readFileSync(filePath(), 'utf8')
  } catch {
    return null
  }
  cache = { key, raw }
  return raw
}

function load() {
  const raw = readRaw()
  if (raw === null) return { version: 1, items: [] } /* 还没建过 = 空，不是错 */
  try {
    const parsed = JSON.parse(raw)
    const items = Array.isArray(parsed.items)
      ? parsed.items.filter((item) => item && typeof item.triggerText === 'string')
      : []
    return { version: 1, items }
  } catch (error) {
    log.error(
      `经验文件解不开（已另存 ${keepCorruptCopy(filePath())}）：${error instanceof Error ? error.message : error}`,
    )
    /* 坏文件的原文不能再留在缓存里 —— 否则下一次 load 还是那一份烂内容 */
    cache = { key: '', raw: '' }
    return { version: 1, items: [] }
  }
}

function persist(data) {
  fs.mkdirSync(DIRS.data, { recursive: true })
  const { kept, dropped } = guard.splitSafe(data.items, redact.looksSecret)
  if (dropped.length > 0) {
    /* 诊断只说「丢弃了几条、哪几个 id」，**不含原文** */
    log.warn(`经验落盘前拦下 ${dropped.length} 条（文本仍像密钥）：${dropped.join(',')}`)
  }
  const body = JSON.stringify({ version: 1, items: kept }, null, 2)
  writeAtomic(filePath(), body)
  /* 刚写下去的这份就是最新内容：把缓存对齐，省掉下一次 load 的读盘 */
  try {
    const stat = fs.statSync(filePath())
    cache = { key: `${stat.mtimeMs}:${stat.size}`, raw: body }
  } catch {
    cache = { key: '', raw: '' }
  }
}

/** 历史留痕：谁把它从什么改成了什么（「为什么不注入了」要能查） */
function recordMove(item, from, to, why) {
  item.status = to
  item.updatedAt = Date.now()
  item.history = Array.isArray(item.history) ? item.history : []
  item.history.push({ at: item.updatedAt, from, to, why: String(why ?? '').slice(0, 120) })
}

/** 容量控制：先清已经明确没用的（rejected / deprecated）最旧的 */
function trim(data) {
  if (data.items.length <= schema.MAX_ITEMS) return
  const removable = data.items
    .filter((item) => !schema.INJECTABLE.has(item.status) && item.status !== schema.STATUS.CANDIDATE)
    .sort((a, b) => a.updatedAt - b.updatedAt)
  while (data.items.length > schema.MAX_ITEMS && removable.length > 0) {
    const victim = removable.shift()
    data.items = data.items.filter((item) => item.id !== victim.id)
  }
}

/** 注入账：记住「这条被注进过提示」—— 反例判定要用它区分「用过才坏」 */
function touchInjected(ids) {
  const list = Array.isArray(ids) ? ids : [ids]
  if (list.length === 0) return { ok: true, touched: 0 }
  const data = load()
  const now = Date.now()
  let touched = 0
  for (const item of data.items) {
    if (!list.includes(item.id)) continue
    item.injectedCount = (item.injectedCount ?? 0) + 1
    item.lastInjectedAt = now
    touched += 1
  }
  if (touched > 0) persist(data)
  return { ok: true, touched }
}

function get(id) {
  return load().items.find((item) => item.id === id) ?? null
}

function stats() {
  const items = load().items
  const byStatus = {}
  for (const item of items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
  return { total: items.length, byStatus, verified: byStatus[schema.STATUS.VERIFIED] ?? 0 }
}

function clear() {
  persist({ items: [] })
  return { ok: true }
}

module.exports = {
  filePath,
  exists,
  load,
  persist,
  recordMove,
  trim,
  touchInjected,
  get,
  stats,
  clear,
  readCount,
}
