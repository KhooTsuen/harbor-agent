/**
 * 自动备份：**清单、路径、扫描**
 *
 * 从 `backup.cjs` 拆出来的（2026-10-04）—— 那边加完「空壳备份」的防护后到了 315 行，
 * 过了 300 行红线。拆法按职责切：这边只有**只读**的东西（清单常量、路径、算体积、列出备份），
 * 真正会动磁盘的（create / restore / remove / prune / maybeAuto）留在 `backup.cjs`。
 *
 * 为什么 `ITEMS` 在这边：`list()` 要拿它算「哪几项缺了 / 是不是空壳」，
 * 放一起就不用两边互相 require。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
/* 体积计算（含缓存与异步版）在 backup-size.cjs —— 那边是唯一一处 */
const { dirSize, dirSizeCached, dirSizeAsync, flushSizes, loadSizes } = require('./backup-size.cjs')

/** 留最近几份。太多没意义，用户也不会去翻 */
const KEEP = 10

/** 备份清单：只备用户自己的东西 */
const ITEMS = [
  { name: 'config.json', dir: false },
  /* `memory.json` —— 以前写的是 `memory.md`（老路径，启动时早被改名了），
     于是记忆从来没被备到过，而备份照报「成功」（审计问题 5） */
  { name: 'memory.json', dir: false },
  { name: 'sessions', dir: true },
  { name: 'skills', dir: true },
  /*
   * 2026-10-13 扩容：这两样也是**不可重建**的用户硬数据 ——
   *   · `tasks`      —— 任务台账（他自己攒出来的活），删了就没有了；
   *   · `changesets` —— 改动事务（回滚凭据），删了就**撤不回去**。
   *
   * ★ **凭证库有意不在清单里**：它已由 `safe-write` 的原子写 + 损坏留档兜底
   *   （E2 专项），而备份它会把 DPAPI 密文**再多复制一份**（纯 Node 无 safeStorage
   *   时甚至是明文），且与既有断言「备份项里不含凭证库」的意图冲突。
   *   取舍见 docs/research/ui-phase5-progress-design.md §5。
   */
  { name: 'tasks', dir: true },
  { name: 'changesets', dir: true },
]

function backupRoot() {
  return path.join(DIRS.data, 'backups')
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/**
 * 这一项里有真东西吗（文件非空 / 目录里有条目）。
 *
 * 首启时 config/memory 还没落盘、sessions 是空目录 → 备份会做成一个「壳」。
 * 恢复这种壳 = 拿空目录盖掉用户现有的对话与技能（审计问题 13）。**按磁盘算**，
 * 所以历史遗留的壳也能被标出来，不只管新写的 meta。
 */
function hasContent(target) {
  try {
    const st = fs.statSync(target)
    if (!st.isDirectory()) return st.size > 0
    return fs.readdirSync(target).length > 0
  } catch {
    return false
  }
}


/** 一份备份的「元信息」（不含体积）—— list 与 listAsync 共用，判据只有一处 */
function describeBackup(dir, name) {
  const full = path.join(dir, name)
  let meta = {}
  try {
    meta = JSON.parse(fs.readFileSync(path.join(full, 'meta.json'), 'utf8'))
  } catch {
    /* 老备份可能没有 meta */
  }
  /* 缺哪几项（没有 / 是空的）；empty = 一个用户项都没有 → 界面禁用「恢复」 */
  const missing = ITEMS.filter((i) => !hasContent(path.join(full, i.name))).map((i) => i.name)
  let createdAt = 0
  try {
    createdAt = fs.statSync(full).mtimeMs
  } catch {
    /* 读不到就排最后 */
  }
  /* 新备份的 `create()` 会把体积写进 meta —— 那就 0 成本，不必再扫一遍盘 */
  const fromMeta = Number(meta.totalBytes)
  return {
    name,
    path: full,
    metaSize: Number.isFinite(fromMeta) && fromMeta > 0 ? fromMeta : null,
    reason: typeof meta.reason === 'string' ? meta.reason : '手动',
    items: Array.isArray(meta.items) ? meta.items : [],
    createdAt,
    empty: missing.length === ITEMS.length,
    missing,
  }
}

function backupNames(root) {
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  /* 同一秒内连点会顺延成 20260914-080206-1，后缀要认得 */
  return entries.filter((e) => e.isDirectory() && isBackupName(e.name)).map((e) => e.name)
}

/**
 * 备份目录名的白名单：`20260914-080206`（同一秒连点会顺延成 `…-1`）。
 *
 * ⚠️ 为什么必须校验（审计问题 14）：`restore(name)` / `remove(name)` 以前直接把
 * 传进来的 name 拼成路径 —— name 是从界面（也就是渲染层）来的，
 * 于是 `remove('../sessions')` 能删掉**数据目录外/内任意目录**，
 * `restore('..\\..\\Windows')` 能拿任意目录盖数据。这个白名单是唯一真相源，
 * `list` / `restore` / `remove` 三处共用。
 */
const NAME_RE = /^\d{8}-\d{6}(-\d+)?$/

function isBackupName(name) {
  return NAME_RE.test(String(name ?? ''))
}

/**
 * 列出所有备份，新的在前。
 *
 * @param {string} [root] 只给测试注入（生产不传 = 真实备份目录）
 * @param {{ sizes?: 'full'|'cache' }} [options]
 *   `'cache'` = **只查缓存，不扫盘**（缺失的体积给 `null`）。启动清理 / 判重只看
 *   时间和份数，不需要体积 —— 让它们走这条路，就不会为了算体积卡住启动。
 * @returns {Array<object>} `size` 可能是 null（= 现在不知道，不是 0）
 */
function list(root = backupRoot(), { sizes = 'full' } = {}) {
  const dir = path.resolve(root)
  const names = backupNames(dir)
  if (names.length === 0) return []
  loadSizes(dir)

  const rows = names.map((name) => {
    const info = describeBackup(dir, name)
    const size =
      info.metaSize ??
      dirSizeCached(info.path, { allowCompute: sizes !== 'cache' })
    return { ...info, size }
  })
  if (sizes !== 'cache') flushSizes(dir)
  return rows.map(({ metaSize, ...rest }) => rest).sort((a, b) => b.createdAt - a.createdAt)
}

/* ══════════════════════════════════════════════════════════════
   后台补算体积 —— 首次升级时的兜底（2026-11-08）
   ══════════════════════════════════════════════════════════════

   老备份没有 `meta.totalBytes`、也没有 `.sizes.json`（第一次跑新版本）。
   那时 `listAsync` 会给 `null`（不知道），并把这些路径丢进这里。

   这里**在后台**逐份算：一份算完让出一次，绝不连着占 CPU。算完写缓存，
   下次打开设置页就有数字了。

   刻意**不推事件给界面**：体积只是展示信息，为它加一条推送通道不值当。
   用户关掉再打开就看到数字了 —— 这符合「先让页面能用，再补内容」。
   ══════════════════════════════════════════════════════════════ */

/** 待补算的目录（去重） */
const warmQueue = new Set()
/** 已经在跑就不重入 */
let warming = false

function warmSizesInBackground() {
  if (warming || warmQueue.size === 0) return
  warming = true
  const step = async () => {
    const one = warmQueue.values().next().value
    if (!one) {
      warming = false
      return
    }
    warmQueue.delete(one)
    try {
      const size = await dirSizeAsync(one)
      if (size !== null) dirSizeCached(one, { remember: size })
      const root = path.dirname(one)
      flushSizes(root)
    } catch {
      /* 算不出来就算了 —— 下次打开列表时再登记一次 */
    }
    setImmediate(step)
  }
  setImmediate(step)
}

/**
 * 异步版 `list` —— **IPC 用这个**。
 *
 * 为什么不能直接用同步 `list()`：它会为每份备份递归 `statSync`。
 * 真机实测（12 份 / 22615 个文件）**6.2~7.0 秒**，而且同步跑在主进程 ——
 * 设置页一打开就卡死，界面完全点不动。
 *
 * 现在：体积优先取 `meta.totalBytes`（新备份都有）/ 缓存；都拿不到就先给
 * `null`（= 不知道），丢给后台补算。**稳态下一次盘都不扫**（约 30ms）。
 */
async function listAsync(root = backupRoot(), { sizes = 'full' } = {}) {
  const dir = path.resolve(root)
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const names = entries.filter((e) => e.isDirectory() && isBackupName(e.name)).map((e) => e.name)
  if (names.length === 0) return []
  loadSizes(dir)

  const rows = []
  for (const name of names) {
    const info = describeBackup(dir, name)
    let size = info.metaSize
    if (size === null) {
      const cached = dirSizeCached(info.path, { allowCompute: false })
      if (cached !== null) {
        size = cached
      } else if (sizes !== 'cache') {
        /*
         * ★ 冷路径**不等**扫盘（2026-11-08 真机修）：
         *   Dev 现场 12 份 / 22615 个文件，全扫要 7~10 秒。异步虽然不阻塞事件循环，
         *   但用户仍要盯着「读取中」等十秒 —— 那还是卡。
         *   所以：没缓存就**先给 null**（= 不知道，不是 0），把这份登记到后台队列，
         *   下次打开（或本轮稍后）缓存里就有了。稳态下这里一次盘都不扫。
         */
        size = null
        warmQueue.add(info.path)
      }
    }
    rows.push({ ...info, size })
  }
  if (sizes !== 'cache') flushSizes(dir)
  warmSizesInBackground()
  return rows.map(({ metaSize, ...rest }) => rest).sort((a, b) => b.createdAt - a.createdAt)
}

module.exports = {
  KEEP,
  ITEMS,
  backupRoot,
  stamp,
  hasContent,
  dirSize,
  list,
  listAsync,
  isBackupName,
}
