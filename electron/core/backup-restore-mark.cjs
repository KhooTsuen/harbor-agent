/**
 * 恢复过程的「进行中」标记（第 13 项，2026-11-10）
 *
 * ── 病是什么 ──────────────────────────────────────────────────
 * `backup.restore()` 是**逐项「先删后拷」**的破坏性操作。它本来有两道保护：
 *   ① 先留 before-restore 快照再动手；
 *   ② 中途抛错就 `rollbackFrom` 把动过的项拷回来。
 *
 * 但这两道都依赖 **catch 能执行**。进程被强杀 / 断电 / 崩溃时 catch 根本不会跑 ——
 * 数据就停在「一半新、一半旧（或某一项被删空）」的状态，而**重启后没有任何标记**
 * 说明上次恢复没做完。用户看到的是「有些会话回来了、有些没了」，程序也毫不知情，
 * 下次恢复还会在同一个中间态上继续盖。
 *
 * ── 怎么修 ────────────────────────────────────────────────────
 * 恢复**开始前**落一个标记（`data/restore-in-progress.json`），每处理完一项更新
 * `touched`，正常收尾（成功 / 已回滚）时删掉。于是：
 *   · 标记还在 → 上次恢复没走到收尾 = 被打断了，`pending()` 能说出是哪份备份、
 *     哪份 before-restore 快照、盖到第几项停的；
 *   · 标记不在 → 没有未完成的恢复。
 *
 * ── 两条刻意的决定 ────────────────────────────────────────────
 * ① **写不下标记就不恢复**（`begin` 直接抛）。理由和「留不下快照就不恢复」同源：
 *    没有标记就无法识别中断，等于再造一个「悄悄停在中间态」的坑。
 * ② 进度更新**写失败只记日志、不中断恢复**。已经删了一半的数据不会因为少记一项
 *    就变好；把恢复做完比把账记完美更重要。
 *
 * ⚠️ 这个文件放在 `data/` 根下，**不在 backup-scan 的 ITEMS 清单里**，所以它
 *    不会被备份、也不会被恢复覆盖 —— 标记必须活过它记录的那次恢复。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
/* 原子写只有一处实现（safe-write.cjs：临时文件 + 「文件被占着」退避重试） */
const { writeAtomic } = require('./safe-write.cjs')

/** 标记文件名。改它等于让旧标记失联，别改 */
const FILE = 'restore-in-progress.json'

function filePath() {
  return path.join(DIRS.data, FILE)
}

/**
 * 开始一次恢复。**写不下就抛**（调用方据此中止，不动任何数据）。
 *
 * @param {string} name   要恢复的那份备份名
 * @param {string} safety 本次 before-restore 快照名（回退就靠它）
 */
function begin(name, safety) {
  const mark = {
    name: String(name ?? ''),
    safety: String(safety ?? ''),
    startedAt: Date.now(),
    touched: [],
  }
  writeAtomic(filePath(), JSON.stringify(mark))
  return mark
}

/** 处理完一项后更新进度。写失败只记日志 —— 别让记账失败打断已经在进行的恢复 */
function touch(itemName) {
  const current = pending()
  if (!current) return
  const name = String(itemName ?? '')
  if (!name) return
  const touched = Array.isArray(current.touched) ? [...current.touched, name] : [name]
  try {
    writeAtomic(filePath(), JSON.stringify({ ...current, touched }))
  } catch (error) {
    log.warn(`恢复进度写不下去（${filePath()}）：${error instanceof Error ? error.message : error}`)
  }
}

/** 收尾（成功或已回滚）→ 删掉标记。删不掉也只是多一条下次启动的提示，不该抛 */
function finish() {
  try {
    fs.rmSync(filePath(), { force: true })
  } catch (error) {
    log.warn(`删恢复标记失败（${filePath()}）：${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 有没有未完成的恢复。
 *
 * @returns {null | { name: string, safety: string, startedAt: number, touched: string[] }}
 *   没有标记返回 null；有就返回标记内容（字段缺失时给空值，不抛）
 */
function pending() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    return {
      name: String(raw.name ?? ''),
      safety: String(raw.safety ?? ''),
      startedAt: Number(raw.startedAt) || 0,
      touched: Array.isArray(raw.touched) ? raw.touched.map((x) => String(x)) : [],
    }
  } catch {
    /* 读不到 / 坏 JSON 都当「没有」—— 标记本身不是用户数据，坏了不该拦启动 */
    return null
  }
}

module.exports = { begin, touch, finish, pending, filePath }
