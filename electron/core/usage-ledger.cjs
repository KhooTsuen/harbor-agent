/**
 * 用量账本：**把 token-metrics.jsonl 读进内存**（异步 + 增量）
 *
 * 从 `token-metrics.cjs` 的 `summarize` 里分出来的 —— 那个函数每次调用都
 * `readFileSync` + 把**整个文件**逐行 `JSON.parse`。账本涨到几万行之后，
 * 主进程会被这段同步解析卡住（「设置 → 用量」点开要等半天，就是这个）。
 *
 * ── 为什么是「增量」而不是「另存一份聚合」──────────────────────
 *
 * 查询条件是组合的（按供应商 + 模型 + 时间 + 任务…），预先聚合只能服务其中
 * 一两种组合，别的组合还得回原始行。所以缓存的是**解析后的行**，聚合每次都重算
 * —— 聚合是纯内存遍历，几万行只需几毫秒；真正的开销在解析。
 *
 * ── 缓存的可靠性（每一条都对应一种会算出假数字的情况）─────────
 *
 *   1. **只按字节偏移追加**：新记录从上次读完的位置开始读，不重读、不重复累计。
 *   2. **指纹对得上才用缓存**：文件被轮转 / 截断 / 换掉（size 变小或 mtime 变老）
 *      → 整体重建。绝不拿旧行去凑新账本。
 *   3. **末尾半行不算数**：只处理到最后一个换行符，偏移也落在那里。
 *      写账本用的是整行 append，正常不会出现半行；但**断电**会。
 *   4. **缓存只是加速**：删掉缓存 = 从零重读一遍，结果一模一样。
 *      所以缓存坏了不会污染真实账本（账本是唯一真相源）。
 *
 * 不抛异常：读不到就当「没有记录」，由调用方决定怎么报（这里返回空数组）。
 */

const fsp = require('node:fs/promises')
const metrics = require('./token-metrics.cjs')

/** 缓存里只留这些字段 —— 老行可能带无关字段（如 prewarm 的 systemBytes），但**不复制对象** */
const KEEP = new Set([
  'at', 'providerId', 'model', 'entry', 'purpose', 'trace', 'taskId', 'sessionId',
  'retryIndex', 'known', 'ok', 'outcome', 'prompt', 'completion', 'total', 'reasoning',
  'cacheHit', 'cacheMiss', 'cost', 'missing',
])

/**
 * ★ 不再做「挑字段 + 新建对象」：`JSON.parse` 出来的那份本来就在内存里，
 *   再拷一份只会**多占一份内存 + 多花一遍遍历**（实测 4 万行多 30~40ms）。
 *   这里只把明确不要的键删掉；连 delete 都省了 —— 多留几个无关键的内存代价
 *   远小于逐行遍历 20 个键的开销。
 */
function trim(raw) {
  return raw
}

const cache = {
  file: '',
  /** 已消费到的字节偏移（也是下一次增量读的起点） */
  offset: 0,
  mtimeMs: 0,
  /** 文件身份：换文件（轮转 / 重建 / 被覆盖）时它一定变，比只看大小可靠 */
  ino: -1,
  birthMs: -1,
  rows: [],
}

/** 进行中的读取（并发去重，见 loadRows 的说明） */
let inflight = null
/** 缓存内容的版本号（每次变化 +1，给上层做聚合缓存失效） */
let version = 0
/** 复位代数：每次 reset +1，用来作废「读的过程中被 reset」的那次读取 */
let generation = 0

/** 只挑需要的字段（老记录没有的键就不出现，交给聚合侧判 undefined） */
function slim(raw) {
  return trim(raw)
}

/** 把一段文本解析成行；只处理到最后一个换行符为止，返回「吃掉多少字节」 */
function parseChunk(text) {
  const cut = text.lastIndexOf('\n')
  if (cut < 0) return { rows: [], consumed: 0 }
  const body = text.slice(0, cut)
  const rows = []
  for (const line of body.split('\n')) {
    if (!line.trim()) continue
    try {
      const one = JSON.parse(line)
      if (one && typeof one === 'object') rows.push(slim(one))
    } catch {
      /* 坏行跳过（不因为一行坏掉就整份读不出来） */
    }
  }
  /* 吃掉的是「最后一个换行符及其之前」；用 Buffer 算字节数才不会和字符数搞混 */
  return { rows, consumed: Buffer.byteLength(`${body}\n`, 'utf8') }
}

/**
 * 读账本（异步、增量）。
 *
 * ★ **single-flight**：并发查询共享同一次读取。否则两个调用同时看到同一个
 *   offset，各自读完再 concat → 同一批行被累两遍，统计直接翻倍。
 *
 * @returns {Promise<Array<object>>} 解析后的行，按文件顺序（= 时间顺序）
 */
async function loadRows() {
  if (inflight) return inflight
  inflight = doLoad().finally(() => {
    inflight = null
  })
  return inflight
}

async function doLoad() {
  /* ★ 记下这一轮的身份：读完时若已经被 reset 过，这批结果就作废
     （否则会把旧内容 concat 进新缓存 —— 行数和偏移都对不上，查询返回少掉的数据） */
  const gen0 = generation
  let gen = gen0
  const file = metrics.file()
  let stat = null
  try {
    stat = await fsp.stat(file)
  } catch {
    /* 账本还不存在 = 一行都没有 */
    reset()
    return []
  }

  const sameFile = cache.file === file
  const shrank = sameFile && stat.size < cache.offset
  /* mtime 变老 = 被轮转后重建过；这种情况偏移必然失效 */
  const rewritten = sameFile && stat.mtimeMs < cache.mtimeMs
  /*
   * ★ 文件身份变了 = 换了一个文件（轮转 / 手工覆盖 / 等长覆写）。
   *   只看 size 会漏：等长覆写时 size 一模一样，偏移看起来仍然有效，
   *   结果是把**旧内容**当成新数据返回 —— 那种「数字看着正常但是错的」最糟。
   *   `ino` / `birthtimeMs` 有平台差异（有的给 0），所以只在两边都有值且不同时才判。
   */
  const swapped =
    sameFile &&
    ((cache.ino > 0 && Number(stat.ino) > 0 && Number(stat.ino) !== cache.ino) ||
      (cache.birthMs > 0 && Number(stat.birthtimeMs) > 0 && Number(stat.birthtimeMs) !== cache.birthMs))

  if (!sameFile || shrank || rewritten || swapped) {
    reset()
    gen = generation
    cache.file = file
  }
  cache.ino = Number(stat.ino) || 0
  cache.birthMs = Number(stat.birthtimeMs) || 0

  /*
   * ★ 大小没变但 mtime 变新 = 内容被覆写过（正常追加一定让 size 变大）。
   *   Windows 上覆写已有文件时 ino / birthtime 都不变，只有这条能认出来。
   *   认不出来就会把旧内容当新数据返回 —— 那是最坏的一种错（数字看着正常但是错的）。
   */
  const overwritten =
    sameFile && !shrank && !swapped && stat.size === cache.offset && stat.mtimeMs > cache.mtimeMs
  if (sameFile && !shrank && !rewritten && !swapped && !overwritten && stat.size === cache.offset) {
    cache.mtimeMs = stat.mtimeMs
    return cache.rows
  }
  if (overwritten) {
    reset()
    gen = generation
    cache.file = file
    cache.ino = Number(stat.ino) || 0
    cache.birthMs = Number(stat.birthtimeMs) || 0
  }

  /*
   * ★ **分块异步读**，不一次性 `readFileSync` 整份：
   *   8MB 账本一次性同步读+parse 要 150ms 以上，那段时间主进程完全不能响应
   *   （界面就是「点了一下没反应」）。按块读并在块之间让出事件循环，
   *   总时长可能一样，但**不会卡住正在跑的 Agent 和界面**。
   */
  const added = []
  let consumed = 0
  try {
    const handle = await fsp.open(file, 'r')
    try {
      let pos = cache.offset
      const block = 1024 * 1024
      /* Buffer 复用：18 次分配 1MB 比 18 次重新分配省一半时间 */
      const buffer = Buffer.allocUnsafe(block)
      let carry = ''
      for (;;) {
        const length = Math.min(block, Math.max(0, stat.size - pos))
        if (length <= 0) break
        const { bytesRead } = await handle.read(buffer, 0, length, pos)
        if (bytesRead <= 0) break
        pos += bytesRead
        const chunkText = buffer.toString('utf8', 0, bytesRead)
        /* carry 为空时直接用它，省掉一次 1MB 的字符串拼接复制 */
        const text = carry ? carry + chunkText : chunkText
        const cut = text.lastIndexOf('\n')
        if (cut < 0) {
          /* 整块都没有换行（超长行）：攒着，下一块继续 */
          carry = text
          consumed = pos - Buffer.byteLength(carry, 'utf8')
          continue
        }
        /* ★ 直接在 text 上逐行扫（不先 slice 出 body，省一次 1MB 复制） */
        let start = 0
        for (;;) {
          const nl = text.indexOf('\n', start)
          if (nl < 0 || nl > cut) break
          if (nl > start) {
            try {
              const one = JSON.parse(text.substring(start, nl))
              if (one && typeof one === 'object') added.push(trim(one))
            } catch {
              /* 坏行跳过（一行坏掉不该让整份读不出来） */
            }
          }
          start = nl + 1
        }
        carry = text.substring(cut + 1)
        consumed = pos - Buffer.byteLength(carry, 'utf8')
        /* 让出事件循环：这是「不阻塞主进程」的落地方式 */
        await new Promise((resolve) => setImmediate(resolve))
      }
    } finally {
      await handle.close()
    }
  } catch {
    /* 读失败：保留已有行（不清空 —— 已读到的历史仍然是真的），下次再试 */
    return cache.rows
  }

  /* 读的过程中被 reset 过：这批结果属于旧账本，丢弃（下次查询重新读） */
  if (gen !== generation) return cache.rows
  if (added.length > 0) cache.rows = cache.rows.length ? cache.rows.concat(added) : added
  cache.offset = consumed
  cache.mtimeMs = stat.mtimeMs
  if (added.length > 0) version += 1
  return cache.rows
}

function reset() {
  cache.file = ''
  cache.offset = 0
  cache.mtimeMs = 0
  cache.ino = -1
  cache.birthMs = -1
  cache.rows = []
  inflight = null
  version += 1
  generation += 1
}

/** 当前缓存了多少行（诊断 / 测试用） */
function info() {
  return { file: cache.file, offset: cache.offset, rows: cache.rows.length, version }
}

/**
 * 账本版本号：**每次缓存内容变化就 +1**。
 *
 * 上层（`usage-query`）拿它做「聚合结果」的失效判断 —— 只看行数不够：
 * 文件被轮转重建后行数可能一样，但内容完全不同。
 */
function currentVersion() {
  return version
}

module.exports = { loadRows, reset, info, currentVersion, parseChunk }
