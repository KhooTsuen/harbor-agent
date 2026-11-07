/**
 * 自动备份：**体积**（从 `backup-scan.cjs` 拆出来的，2026-11-08）
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────
 *
 * 加完「体积缓存 + 异步版」之后 `backup-scan.cjs` 到了 369 行（硬约束 #2 是 300）。
 * 按职责切最省事：这边只回答「这个目录多大」，`list` / 备份清单 / 名字白名单留在那边。
 *
 * ── 目录 mtime 为什么能当缓存键 ──────────────────────────────
 *
 * 备份目录是**写完就不再动**的（create 一次性拷完，之后只有删）。往里加文件会
 * 让目录自身 mtime 变 —— 所以 (路径, 目录 mtime) 命中就说明内容没变过。
 * 万一 mtime 没变而内容变了（几乎不可能，要手工改），最坏是多显示一个旧体积，
 * **不会影响任何删除/恢复判据**（那些看的是名字与 meta，不看体积）。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

function dirSize(target) {
  let total = 0
  const walk = (p) => {
    let entries
    try {
      entries = fs.readdirSync(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(p, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try {
          total += fs.statSync(full).size
        } catch {
          /* 读不到就算了 */
        }
      }
    }
  }
  try {
    if (fs.statSync(target).isDirectory()) walk(target)
    else return fs.statSync(target).size
  } catch {
    return 0
  }
  return total
}

/* ══════════════════════════════════════════════════════════════
   体积缓存 —— 为什么必须有（2026-11-08 真机实测）
   ══════════════════════════════════════════════════════════════

   `dirSize` 是**递归 statSync**。Dev 现场：12 份备份 / 22615 个文件，
   一次 `list()` = **6.2~7.0 秒**，而且它在主进程里**同步**跑。后果：

     · 设置页「数据与用量」一打开就卡死（`BackupPanel` 挂载即拉列表）
     · 启动清理 `pruneBackups()` 卡一次
     · 自动备份判重 `maybeAuto()` 卡一次
     · 每次 `create()` 末尾 `prune()` 再卡一次

   判据：**备份目录写完就不再变**（目录自身 mtime 定住）。所以按
   (路径, 目录 mtime) 缓存体积：磁盘落一份 `.sizes.json`，进程内再一层 Map。
   mtime 变了（正在写 / 用户往里加了东西）就重算 —— **不会给过期数字**。

   `.sizes.json` 是文件不是目录，`list()` 只取 `isDirectory()`，不会被当备份。
   ══════════════════════════════════════════════════════════════ */

const SIZES_NAME = '.sizes.json'
/** 缓存有效期：过期当「不知道」，交给后台重算（见 dirSizeCached 的 TTL 说明） */
const CACHE_TTL_MS = 10 * 60 * 1000
/** 全路径 → { mtimeMs, size } */
const sizeCache = new Map()
/** 已经读过落盘缓存的 root（每个 root 只读一次） */
const sizesLoaded = new Set()
/** 有新增/变更、需要回写的 root */
const dirtyRoots = new Set()

function sizesFile(root) {
  return path.join(root, SIZES_NAME)
}

function loadSizes(root) {
  if (sizesLoaded.has(root)) return
  sizesLoaded.add(root)
  try {
    const raw = JSON.parse(fs.readFileSync(sizesFile(root), 'utf8'))
    for (const [name, value] of Object.entries(raw)) {
      const size = Number(value?.size)
      if (!Number.isFinite(size)) continue
      sizeCache.set(path.join(root, name), {
        mtimeMs: Number(value?.mtime) || 0,
        size,
        /* 落盘时间：TTL 判据用它。老缓存文件里没有 → 当作很久以前，下次重算一次 */
        at: Number(value?.at) || 0,
      })
    }
  } catch {
    /* 没有 / 坏了 = 全部当没缓存、重算一遍（缓存丢了只影响速度，不影响数字） */
  }
}

function flushSizes(root) {
  if (!dirtyRoots.has(root)) return
  dirtyRoots.delete(root)
  const out = {}
  for (const [full, value] of sizeCache) {
    if (path.dirname(full) !== root) continue
    out[path.basename(full)] = { mtime: value.mtimeMs, size: value.size, at: value.at ?? 0 }
  }
  try {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(sizesFile(root), JSON.stringify(out), 'utf8')
  } catch {
    /* 写不进就每次重算，不影响正确性 */
  }
}

/**
 * 带缓存的体积。
 *
 * @param {string} target 备份目录（或文件）
 * @param {{ allowCompute?: boolean, remember?: number }} [options]
 *   `allowCompute: false` = 只查缓存，没命中返回 null；
 *   `remember: n` = 把**已经算好的** n 记进缓存（异步路径算完之后用它登记，
 *   免得缓存变量在这一层之外被直接摸——那样一改名就静默失效，2026-11-08 踩过）。
 * @returns {number|null} null = 现在不知道（**不要当成 0**，那是「确认为空」）
 */
function dirSizeCached(target, { allowCompute = true, remember } = {}) {
  let mtimeMs = 0
  try {
    const st = fs.statSync(target)
    if (!st.isDirectory()) return st.size
    mtimeMs = st.mtimeMs
  } catch {
    return null
  }

  const key = path.resolve(target)
  if (Number.isFinite(remember)) {
    sizeCache.set(key, { mtimeMs, size: Number(remember), at: Date.now() })
    dirtyRoots.add(path.dirname(key))
    return Number(remember)
  }
  const hit = sizeCache.get(key)
  if (hit && hit.mtimeMs === mtimeMs) {
    /*
     * ★ TTL 兜底（2026-11-08 实测发现的洞）：
     *   「目录 mtime 变了 = 内容变了」只在**直接往这一层加/删文件**时成立。
     *   往**子目录**里加文件不会改父目录的 mtime —— 那时缓存会一直给出偏小的旧值。
     *   所以给缓存加有效期：过期就当作「不知道」（返回 null），
     *   上层会把它重新丢进后台补算队列。**界面永远不会因为它去扫盘。**
     */
    if (allowCompute || Date.now() - (hit.at ?? 0) < CACHE_TTL_MS) return hit.size
    return null
  }
  if (!allowCompute) return null

  const size = dirSize(target)
  sizeCache.set(key, { mtimeMs, size, at: Date.now() })
  dirtyRoots.add(path.dirname(key))
  return size
}

/**
 * 异步版体积 —— 每 200 个文件让出一次事件循环。
 *
 * 为什么不能直接在 IPC 里调同步 `dirSize`：单份 300MB / 约 1900 个文件要
 * 约 600ms，主进程被占住时界面点不动、正在跑的 Agent 也停着。
 *
 * @returns {Promise<number|null>} null = 读不到（不是 0）
 */
async function dirSizeAsync(target) {
  let total = 0
  let sinceYield = 0
  const walk = async (dir) => {
    let entries = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      try {
        total += (await fsp.stat(full)).size
      } catch {
        /* 读不到就算了 */
      }
      sinceYield += 1
      if (sinceYield >= 200) {
        sinceYield = 0
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
  }
  try {
    const st = await fsp.stat(target)
    if (!st.isDirectory()) return st.size
    await walk(target)
  } catch {
    return null
  }
  return total
}

module.exports = { dirSize, dirSizeCached, dirSizeAsync, flushSizes, loadSizes, SIZES_NAME }
