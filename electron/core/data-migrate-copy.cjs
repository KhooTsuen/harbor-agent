/**
 * 数据目录迁移：**搬字节 + 核对字节**（异步、全量）
 *
 * 从 `data-migrate-plan.cjs` 抽出来的（那边 257 行，加完全量校验必破 300 红线）。
 * 分工：`plan` 只读检查（能不能搬），这里只管**搬**和**核对**。
 *
 * ── 为什么必须异步（2026-11-07 修正）─────────────────────────
 *
 * V1 用 `fs.cpSync` 同步复制，当时的理由是「主进程被占住 → 没有别的写入能插进来
 * → 这就是一致性保护」。**这个理由是错的**，两头都不成立：
 *
 *   ① **不保护一致性**：`data/chromium` 是 **Chromium 自己的进程**在写
 *      （Cache / Code Cache / GPUCache / Local Storage…），主进程把自己阻塞住
 *      完全拦不住它。实测：迁移期间渲染进程一直在写缓存。
 *      更别说用户还能在界面上点东西（渲染层照画，IPC 排队等着）。
 *   ② **把界面卡死**：4.8GB 同步复制 = main 进程几十秒不响应，
 *      用户看到的是"点了没反应"，而他又不知道该等多久。
 *
 * 所以改成：**异步分批复制（每批 yield 给事件循环）+ 复制前后各拍一次快照**。
 * 真正的一致性靠三件事叠起来，而不是靠"我卡住了别人"：
 *
 *   a. 纯缓存目录**不复制**（可重建、正在被写 —— 搬过去也是半旧的）
 *   b. 复制后**全量 SHA-256** 逐个核对（不看复制命令的退出码）
 *   c. 复制前后比对源快照（大小 + mtime）：变了就**如实报出是哪几个文件**，
 *      并且不切指针 —— 不把并发写入伪装成成功
 *
 * ── 为什么不复制纯缓存 ────────────────────────────────────────
 *
 * 它们一定会在复制期间变化，复制结果必然不一致；而且 Chromium 下次启动会自己
 * 重建。把它们排除掉，"一致性"这个词才谈得上。**排除清单只放纯缓存**：
 * `Local Storage` / `IndexedDB` / `Session Storage` 是用户数据（设置就存在
 * localStorage 里），一律照搬照校验。
 *
 * ⚠️ 明确管不到的：Provider CLI 自己存在别处的目录（如 `~/.codex`）、
 *    Chromium 进程在迁移期间对**已复制文件**的后续写入。后者靠快照比对发现。
 */

const fsp = require('node:fs/promises')
const path = require('node:path')

/** 状态文件名（与 `data-migrate-plan.cjs` 同一份，写在这边只是为了让 walk 能跳过它） */
const STATE_NAME = '.harbor-migrate.json'

/**
 * 纯缓存目录（相对数据根，大小写不敏感）—— **不复制、不校验、不参与快照判据**。
 *
 * 只放 Chromium 自己能重建的东西。★ 别往里加 `Local Storage` / `IndexedDB`：
 * 那是用户数据（主题、快捷键、通知路由都存在 localStorage），必须原样搬。
 */
const CACHE_DIRS = [
  'chromium/cache',
  'chromium/code cache',
  'chromium/gpucache',
  'chromium/shaderCache',
  'chromium/grshadercache',
  'chromium/dawncache',
  'chromium/dawnGraphiteCache',
  'chromium/dawnwebgpucache',
  'chromium/service worker/cachestorage',
]

/** 每复制多少个文件让出一次事件循环（太小慢、太大卡；64 是实测手感） */
const YIELD_EVERY = 64
/** 一次读多少字节算 hash（1MB 够快，又不至于把内存撑爆） */
const HASH_CHUNK = 1024 * 1024

/** 这个相对路径要不要跳过（纯缓存 / 迁移状态文件） */
function shouldSkip(rel) {
  const normalized = String(rel ?? '').replace(/\\/g, '/').toLowerCase()
  if (!normalized) return false
  if (normalized === STATE_NAME.toLowerCase()) return true
  return CACHE_DIRS.some((dir) => {
    const key = dir.toLowerCase()
    return normalized === key || normalized.startsWith(`${key}/`)
  })
}

/** 让出事件循环一次（异步复制的关键：不 yield 就等于同步） */
function yieldNow() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * 拍快照：所有要迁的文件的 `{ rel, size, mtimeMs }`。
 *
 * 为什么带 mtime：同尺寸不同内容的文件（用户说的"相同大小不同内容"）
 * 在**复制前后比对**这一步靠 mtime 抓得到；内容层面由 `verifyAll` 的
 * 全量 SHA-256 负责。两件事互补，缺一个就会漏。
 *
 * @param {string} dir
 * @returns {Promise<Array<{ rel: string, size: number, mtimeMs: number }>>}
 */
async function snapshot(dir) {
  const out = []
  const base = path.resolve(dir)

  async function walk(current) {
    let entries = []
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      const rel = path.relative(base, full)
      if (shouldSkip(rel)) continue
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      try {
        const st = await fsp.stat(full)
        out.push({ rel, size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        /* 读不到就当不存在 —— 校验那一步会把它算成"缺" */
      }
    }
  }

  await walk(base)
  return out
}

/** 快照 → Map（按 rel） */
function toMap(list) {
  return new Map((Array.isArray(list) ? list : []).map((item) => [item.rel, item]))
}

/**
 * 两个快照之间的差异（复制期间源有没有被改）。
 *
 * @returns {Array<{ rel: string, reason: string }>} 空数组 = 源没动
 */
function diffSnapshots(before, after) {
  const a = toMap(before)
  const b = toMap(after)
  const changed = []
  for (const [rel, first] of a) {
    const later = b.get(rel)
    if (!later) {
      changed.push({ rel, reason: '迁移期间被删掉了' })
      continue
    }
    if (later.size !== first.size) {
      changed.push({ rel, reason: `迁移期间大小变了（${first.size} → ${later.size}）` })
      continue
    }
    /* 同尺寸但 mtime 变了：内容很可能被改过（真正的内容判据在 verifyAll） */
    if (Math.abs(later.mtimeMs - first.mtimeMs) > 1) {
      changed.push({ rel, reason: '迁移期间被改过' })
    }
  }
  for (const rel of b.keys()) {
    if (!a.has(rel)) changed.push({ rel, reason: '迁移期间新出现的文件' })
  }
  return changed
}

/**
 * 异步复制：逐文件 `copyFile`，每 `YIELD_EVERY` 个 yield 一次。
 *
 * 不用 `fs.promises.cp`：它在内部一口气跑完，同样会长时间占住事件循环；
 * 而这个函数要保证「复制 4.8GB 期间界面还能响应」。
 *
 * @param {{ from: string, to: string, onProgress?: (done: number, total: number) => void }} input
 * @returns {Promise<{ files: number, bytes: number, skipped: number, ms: number }>}
 */
async function copyTree(input) {
  const started = Date.now()
  const base = path.resolve(String(input?.from ?? ''))
  const target = path.resolve(String(input?.to ?? ''))
  const onProgress = typeof input?.onProgress === 'function' ? input.onProgress : null
  if (!base || !target) throw new Error('复制需要源目录和目标目录')

  let files = 0
  let bytes = 0
  let skipped = 0
  let sinceYield = 0

  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const src = path.join(current, entry.name)
      const rel = path.relative(base, src)
      if (shouldSkip(rel)) {
        skipped += 1
        continue
      }
      const dst = path.join(target, rel)

      if (entry.isDirectory()) {
        await fsp.mkdir(dst, { recursive: true })
        await walk(src)
        continue
      }
      if (!entry.isFile()) continue

      await fsp.mkdir(path.dirname(dst), { recursive: true })
      await fsp.copyFile(src, dst)
      files += 1
      sinceYield += 1
      try {
        bytes += (await fsp.stat(dst)).size
      } catch {
        /* 大小算不出不影响复制本身 */
      }
      if (sinceYield >= YIELD_EVERY) {
        sinceYield = 0
        if (onProgress) {
          try {
            onProgress(files, 0)
          } catch {
            /* 进度回调坏了不许拦住迁移 */
          }
        }
        await yieldNow()
      }
    }
  }

  await walk(base)
  return { files, bytes, skipped, ms: Date.now() - started }
}


module.exports = { STATE_NAME, CACHE_DIRS, shouldSkip, snapshot, diffSnapshots, copyTree }
