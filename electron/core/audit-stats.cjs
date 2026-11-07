/**
 * 工具调用审计：**统计**（从 `audit.cjs` 拆出来的，2026-11-08）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 *
 * 设置页「数据与用量」一打开就冻结约 1 秒。实测（Dev 现场）：
 *
 *   audit.stats(90)  = 1938 ms   同步读 29 个 jsonl / 137.7 MB / 81737 条
 *
 * 调用链：`DataPortPanel` 挂载 → `countData()` → `auditStats(90)` → 上面那一句。
 * 它跑在**主进程**、**同步**，期间界面完全点不动、正在跑的 Agent 也停着。
 *
 * ── 三条改法（缺一不可）────────────────────────────────────────
 *
 *   ① **异步 + 分块**：`createReadStream` 按行切，每 2000 行让出一次事件循环。
 *      总时长仍要一两秒，但**不再冻结**（界面照常响应，进度是一段段的）。
 *   ② **按天缓存**：审计文件是 `appendFileSync` 追加的，**过去那几天不再变**。
 *      所以 (天, size, mtime) 没变就直接用上次的统计，一个字节都不重读。
 *      实测：第二次打开从 1938 ms 降到个位数毫秒。
 *   ③ **落盘缓存**：进程重启后也能命中，不用每次冷启动都全扫。
 *
 * ── 判据为什么用 size + mtime 两个 ─────────────────────────────
 *
 * 审计只追加：内容变了 size 一定变大。但 Windows 上 mtime 精度约 10ms，
 * 极短时间内的两次追加可能 mtime 相同 —— 两个一起看才不漏。
 * 缓存里另存 `lines`（读到的行数）用于诊断，不参与判据。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')

/** 每读多少行让出一次事件循环 */
const YIELD_EVERY = 2000

/** 缓存文件名（在 audit 目录里；`.` 开头且不是 .jsonl，不会被当成审计文件） */
const CACHE_NAME = '.stats-cache.json'

/** 内存缓存：day → { size, mtimeMs, total, failed, denied, byTool } */
const dayCache = new Map()
/** 已从磁盘载入缓存的 root */
let cacheLoadedFrom = ''
let dirty = false

function dir() {
  return path.join(DIRS.data, 'audit')
}

function cacheFile() {
  return path.join(dir(), CACHE_NAME)
}

/** 有哪些天有记录（新的在前） */
async function daysAsync() {
  let names = []
  try {
    names = await fsp.readdir(dir())
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.replace('.jsonl', ''))
    .sort()
    .reverse()
}

function loadCache() {
  const root = path.resolve(dir())
  if (cacheLoadedFrom === root) return
  cacheLoadedFrom = root
  dayCache.clear()
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'))
    for (const [day, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue
      dayCache.set(day, {
        size: Number(value.size) || 0,
        mtimeMs: Number(value.mtimeMs) || 0,
        total: Number(value.total) || 0,
        failed: Number(value.failed) || 0,
        denied: Number(value.denied) || 0,
        byTool: value.byTool && typeof value.byTool === 'object' ? value.byTool : {},
      })
    }
  } catch {
    /* 没有 / 坏了 = 当没缓存，重算一遍（只影响速度，不影响数字） */
  }
}

function flushCache() {
  if (!dirty) {
    /*
     * ★ 缓存文件被删掉（用户手删 / 上次写失败）但内存里还有 —— 也要重写一份。
     *   否则「文件没了」这个状态会一直持续到进程重启，重启后每次都是冷启动。
     */
    try {
      if (dayCache.size > 0 && !fs.existsSync(cacheFile())) dirty = true
      else return
    } catch {
      return
    }
  }
  dirty = false
  const out = {}
  for (const [day, value] of dayCache) out[day] = value
  try {
    fs.mkdirSync(dir(), { recursive: true })
    fs.writeFileSync(cacheFile(), JSON.stringify(out), 'utf8')
  } catch {
    /* 写不进就每次重算，不影响正确性 */
  }
}

/** 一个空的统计桶 */
function emptyAgg() {
  return { total: 0, failed: 0, denied: 0, byTool: {} }
}

/**
 * 流式统计一天的审计文件。
 *
 * 只累加计数，**不保留 JSON 对象** —— 81737 条全留在内存里没有意义，
 * 界面要的只是「多少条 / 失败几条 / 按工具怎么分」。
 */
function aggregateOne(file, onLine) {
  return new Promise((resolve, reject) => {
    const agg = emptyAgg()
    let rest = ''
    let lines = 0
    /** ★ 按**行数**让出，不是按 chunk 数：一个 chunk 是 256KB、几千行，
     *  按 chunk 计要 2000 个 chunk（约 512MB）才让出一次 —— 等于没让。 */
    let sinceYield = 0
    const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 256 * 1024 })

    const consume = (chunk) => {
      rest += chunk
      let nl = rest.indexOf('\n')
      while (nl >= 0) {
        const line = rest.slice(0, nl)
        rest = rest.slice(nl + 1)
        if (line) {
          try {
            const item = JSON.parse(line)
            agg.total += 1
            if (!item.ok) agg.failed += 1
            if (item.approval === false) agg.denied += 1
            const tool = String(item.tool ?? 'unknown')
            agg.byTool[tool] = (agg.byTool[tool] ?? 0) + 1
          } catch {
            /* 半行（写到一半崩了）跳过 —— 和 read() 同一判据 */
          }
          lines += 1
          sinceYield += 1
        }
        nl = rest.indexOf('\n')
      }
      /* 让出点：返回「攒够没」交给调用方 await */
      return sinceYield >= YIELD_EVERY
    }

    stream.on('data', async (chunk) => {
      stream.pause()
      try {
        const reached = consume(chunk)
        if (reached) {
          sinceYield = 0
          await new Promise((r) => setImmediate(r))
        }
        stream.resume()
      } catch (error) {
        stream.destroy(error)
      }
    })
    stream.on('end', () => {
      /* 最后一行可能没有换行符 */
      if (rest.trim()) {
        try {
          const item = JSON.parse(rest)
          agg.total += 1
          if (!item.ok) agg.failed += 1
          if (item.approval === false) agg.denied += 1
          const tool = String(item.tool ?? 'unknown')
          agg.byTool[tool] = (agg.byTool[tool] ?? 0) + 1
        } catch {
          /* 坏行跳过 */
        }
        lines += 1
      }
      if (onLine) onLine(lines)
      resolve(agg)
    })
    stream.on('error', reject)
  })
}

/**
 * 统计最近 N 天（异步、分块、按天缓存）。
 *
 * 返回形状与同步版 `audit.stats()` **逐字一致**：`{ days, total, failed, denied, byTool }`。
 *
 * @param {number} daysBack 往回看几天（默认 7）
 * @returns {Promise<{ days: number, total: number, failed: number, denied: number,
 *                     byTool: Record<string, number>, cached?: number }>}
 *   `cached` = 其中几天直接命中缓存（诊断用，多出来的字段不影响老调用方）
 */
async function statsAsync(daysBack = 7) {
  loadCache()
  const list = (await daysAsync()).slice(0, Math.max(0, Number(daysBack) || 0))
  let total = 0
  let failed = 0
  let denied = 0
  let cachedDays = 0
  /** @type {Record<string, number>} */
  const byTool = {}

  for (const day of list) {
    const file = path.join(dir(), `${day}.jsonl`)
    let st = null
    try {
      st = await fsp.stat(file)
    } catch {
      continue
    }

    const hit = dayCache.get(day)
    let agg = null
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      agg = hit
      cachedDays += 1
    } else {
      try {
        const fresh = await aggregateOne(file)
        agg = { ...fresh, size: st.size, mtimeMs: st.mtimeMs }
        dayCache.set(day, agg)
        dirty = true
      } catch {
        /* 读不到就跳过这一天（和同步版 continue 同一行为） */
        continue
      }
    }

    total += agg.total
    failed += agg.failed
    denied += agg.denied
    for (const [tool, n] of Object.entries(agg.byTool)) {
      byTool[tool] = (byTool[tool] ?? 0) + n
    }
  }

  flushCache()
  return { days: list.length, total, failed, denied, byTool, cached: cachedDays }
}

/**
 * 扔掉内存里那份统计缓存（**不清磁盘**）。
 *
 * 两个用处：
 *   · 测试要模拟「进程刚重启」的冷路径 —— 只删磁盘文件不够，内存里那份还在，
 *     结果 3 ms 就返回了，测出来的是热路径（2026-11-08 自检里踩过）。
 *   · 运行中清空了审计日志后想让下次重算。
 */
function resetCache() {
  dayCache.clear()
  cacheLoadedFrom = ''
  dirty = false
}

module.exports = { statsAsync, resetCache, CACHE_NAME, YIELD_EVERY }
