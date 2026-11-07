/**
 * 数据目录迁移：**全量核对字节**
 *
 * 从 `data-migrate-copy.cjs` 拆出来的（那边 336 行，硬约束 #2 是 300）。
 * 分界线：那边负责「搬」（复制 + 快照），这里负责「核对」（逐文件 SHA-256）。
 *
 * ── 为什么从抽样改成全量（2026-11-07 修正）───────────────────
 *
 * V1 是抽样：最近改的 12 个 + 最大的 8 个，每份只比头 64KB。
 * 三个漏洞，第四个最要命：
 *
 *   ① **同尺寸不同内容**：大小一致就跳过内容比对 —— 换个字节谁也看不出来。
 *   ② **抽样之外的文件**：10000 个文件里只比 20 个，剩下的坏了照样"通过"。
 *   ③ **只比头 64KB**：大文件后半段截断/损坏完全查不出。
 *   ④ 用户明确要求"把抽样提升为全部迁移文件的内容一致性验证"。
 *
 * 现在逐文件算 SHA-256（流式，不撑爆内存）。4.8GB 大约 20~40 秒（SSD），
 * 而且每 64 个文件让出一次事件循环 —— 期间界面照常响应。
 *
 * ★ 校验**失败**的语义：不切指针、旧数据一个字节没动、如实报出是哪几个文件
 *   （带两边的 hash 前缀，能定位）。绝不把"校验没过"报成迁移成功。
 */

const path = require('node:path')
const crypto = require('node:crypto')
const fs = require('node:fs')
const { snapshot, shouldSkip } = require('./data-migrate-copy.cjs')

/** 每核对多少个文件让出一次事件循环 */
const YIELD_EVERY = 64
/** 一次读多少字节算 hash（1MB 够快，又不至于把内存撑爆） */
const HASH_CHUNK = 1024 * 1024

/**
 * 可以「容忍复制期间漂移」的目录（诊断产物）。
 *
 * ★ 这个名单必须**很短**，而且只能放"删了不影响把活干完"的东西：
 *   logs / events / audit / errors / crash 都是排错材料，有保留期，丢几行无所谓。
 *
 * ★★ 绝不放进去的：`config.json` / `memory.json` / `credentials.json` /
 *   `sessions` / `tasks` / `changesets` / `skills` / `backups`。
 *   那几样是用户数据、回滚凭据和证据 —— 用户迁移完发现配置回到旧版本、
 *   或者会话少了几条，是**不能接受**的。它们必须逐字节一致。
 */
const LOOSE_DIRS = ['logs/', 'events/', 'audit/', 'errors/', 'crash/', 'cache/', 'chat/', 'page-context/']

/** 这个文件允许在迁移期间漂移吗（诊断产物才允许） */
function isLoose(rel) {
  const normalized = String(rel ?? '').replace(/\\/g, '/').toLowerCase()
  return LOOSE_DIRS.some((dir) => normalized.startsWith(dir))
}

/** 让出事件循环一次 */
function yieldNow() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 一个文件的 SHA-256（流式，不把整个文件读进内存） */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file, { highWaterMark: HASH_CHUNK })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * 全量校验：**逐文件比对 SHA-256**。
 *
 * ── 判据（2026-11-07 二次修正，这条最容易写错）─────────────────
 *
 * 参照物是**复制开始前拍的快照**（`source`），不是"校验那一刻的源"。
 * 为什么：Harbor 自己一直在写日志，源在复制期间必然还会增长 —— 若拿"现在的源"
 * 当基准，日志一追加就永远对不上，迁移永远失败（实测：真机模拟日志追加，
 * 校验报"大小不符 1 个"，两轮重拷之后仍然红）。
 *
 * 逐项判：
 *   · 目标缺文件                    → **红**（没拷到）
 *   · 目标比快照**小**               → **红**（拷了一半 / 被截断）
 *   · 目标比快照**大**               → 接受，记为 `grew`（复制时源已经长了一点）
 *   · 目标与快照**一样大**，且源现在也没变 → **逐字节比 SHA-256**（严格）
 *   · 目标与快照一样大，但源现在变了  → 接受并记为 `changed`（目标里是完整的
 *     复制前版本；真正"被同尺寸改写"的情况会落到上一条的严格比对里判红）
 *
 * 一句话：**目标里必须有一份"复制开始那一刻"的完整数据**；期间源怎么长都行，
 * 但每一次偏离都要**记在返回值里**，不静默。
 *
 * @param {{ from: string, to: string, source?: Array<{rel: string, size: number}>,
 *           onProgress?: (done: number, total: number) => void }} input
 *   `source` 传入复制**前**拍的源快照。不传就现拍（那样并发写入会被判红，
 *   只适合"确定没人在写"的场景）。
 * @returns {Promise<{ ok: boolean, error?: string, missing?: string[], sized?: string[],
 *                     bad?: Array<{ rel: string, from: string, to: string }>,
 *                     grew?: string[], changed?: string[], drift?: string[],
 *                     files: number, checked: number, extra: number, ms: number }>}
 */
async function verifyAll(input) {
  const started = Date.now()
  const base = path.resolve(String(input?.from ?? ''))
  const target = path.resolve(String(input?.to ?? ''))
  const onProgress = typeof input?.onProgress === 'function' ? input.onProgress : null
  const source = Array.isArray(input?.source) ? input.source : null
  const srcList = Array.isArray(source) && source.length > 0 ? source : await snapshot(base)
  const dstList = await snapshot(target)
  const dstMap = new Map(dstList.map((item) => [item.rel, item]))
  /* 源**现在**长什么样 —— 只用来判断"复制期间动过没有"，不是判据基准 */
  const nowMap = new Map((await snapshot(base)).map((item) => [item.rel, item]))

  const missing = []
  const sized = []
  const grew = []
  const changed = []
  const pending = []
  for (const item of srcList) {
    const copy = dstMap.get(item.rel)
    if (!copy) {
      missing.push(item.rel)
      continue
    }
    if (copy.size < item.size) {
      sized.push(item.rel)
      continue
    }
    if (copy.size > item.size) {
      /* 复制时源已经长了：诊断产物接受，用户数据不认（配置绝不能"回退一版"） */
      if (isLoose(item.rel)) grew.push(item.rel)
      else sized.push(item.rel)
      continue
    }
    /* 一样大：源现在也还是那个大小 → 可以严格比；否则看是不是诊断产物 */
    const now = nowMap.get(item.rel)
    if (!now || now.size !== item.size) {
      if (isLoose(item.rel)) changed.push(item.rel)
      else sized.push(item.rel)
      continue
    }
    pending.push(item.rel)
  }

  const extra = Math.max(0, dstList.length - srcList.length)
  const drift = [...grew, ...changed]

  /* 缺文件 / 被截短：直接红，不用白算 hash（省掉几 GB 的无用读取） */
  if (missing.length > 0 || sized.length > 0) {
    return {
      ok: false,
      error: `复制不完整：缺 ${missing.length} 个、被截短 ${sized.length} 个`,
      missing: missing.slice(0, 20),
      sized: sized.slice(0, 20),
      grew: grew.slice(0, 20),
      changed: changed.slice(0, 20),
      files: srcList.length,
      checked: 0,
      extra,
      ms: Date.now() - started,
    }
  }

  const bad = []
  let done = 0
  for (const rel of pending) {
    let a = ''
    let b = ''
    try {
      a = await hashFile(path.join(base, rel))
      b = await hashFile(path.join(target, rel))
    } catch (error) {
      /* 读不出来也要算"对不上" —— 不能因为异常就跳过它 */
      bad.push({ rel, from: a.slice(0, 12), to: `读取失败：${error instanceof Error ? error.message : error}` })
      done += 1
      continue
    }
    done += 1
    if (a !== b) bad.push({ rel, from: a.slice(0, 12), to: b.slice(0, 12) })
    if (done % YIELD_EVERY === 0) {
      if (onProgress) {
        try {
          onProgress(done, pending.length)
        } catch {
          /* 进度回调坏了不许拦住校验 */
        }
      }
      await yieldNow()
    }
  }

  if (bad.length > 0) {
    return {
      ok: false,
      error: `有 ${bad.length} 个文件内容对不上（逐字节比过 SHA-256）`,
      bad: bad.slice(0, 10),
      grew: grew.slice(0, 20),
      changed: changed.slice(0, 20),
      files: srcList.length,
      checked: done,
      extra,
      ms: Date.now() - started,
    }
  }

  return {
    ok: true,
    /* 迁移期间源动过的（长了几行 / 被改过）—— 不算失败，但必须让人看见 */
    drift: drift.slice(0, 20),
    grew: grew.slice(0, 20),
    changed: changed.slice(0, 20),
    files: srcList.length,
    checked: done,
    extra,
    ms: Date.now() - started,
  }
}

module.exports = { hashFile, verifyAll, shouldSkip }
