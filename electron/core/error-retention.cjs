/**
 * 内核：错误记录保留期
 *
 * 观察哨一天一个 `data/errors/<日期>.jsonl`，一天几行也不会自己消失 ——
 * 不清理的话几年后就是几千个小文件躺在用户数据目录里。
 * 这个模块在**启动时**（观察哨 install）扫一遍，删掉过期的。
 *
 * 三条自我约束：
 *   1. **只删自己写的文件**：文件名必须严格是 `YYYY-MM-DD.jsonl`，别的形状一律不碰
 *      （用户往这个目录里放别的东西是他的自由，不是我们的清理对象）。
 *   2. **永远保留最新那个文件**：哪怕它比保留期还老（例如半年没开过应用），
 *      也不删 —— 否则「一打开就发现历史空了」，看着像数据丢了。
 *   3. **删了什么要留痕**：删掉的写进主日志。删数据这件事不能静默。
 *
 * 不备份它（`backup.cjs` 的白名单里没有 `data/errors`）：
 * 那本文件开头就写着「日志是排错用的、缓存能重建，备了只是浪费空间」——
 * 错误记录同类：它是诊断材料，随时能用 `npm run errors --export` 再生成一份。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')

/** 保留多少天 */
const KEEP_DAYS = 30

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/**
 * 清掉过期的错误记录。
 *
 * @param {{dir?: string, days?: number, now?: number}} [options]
 * @returns {{ok: boolean, removed: string[], kept: number, reason?: string}} 删除结果（绝不抛）
 */
function prune(options = {}) {
  try {
    const dir = options.dir || DIRS.errors
    const days = Number.isFinite(options.days) && options.days > 0 ? options.days : KEEP_DAYS
    const now = Number.isFinite(options.now) ? options.now : Date.now()
    const cutoff = new Date(now - days * 86_400_000)
    const pad = (n) => String(n).padStart(2, '0')
    const limit = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`

    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      return { ok: true, removed: [], kept: 0, reason: '目录还不存在' }
    }

    const days2 = names.map((name) => ({ name, m: FILE_RE.exec(name) })).filter((x) => x.m)
    if (!days2.length) return { ok: true, removed: [], kept: 0, reason: '没有可清理的文件' }

    /* 按日期倒序 → 第一个是最新的，第 2 个开始才允许删 */
    days2.sort((a, b) => b.m[1].localeCompare(a.m[1]))
    const removed = []
    for (const { name, m } of days2.slice(1)) {
      /* 字符串比日期就够了（YYYY-MM-DD 定长同构） */
      if (m[1] >= limit) continue
      try {
        fs.unlinkSync(path.join(dir, name))
        removed.push(name)
      } catch {
        /* 删不掉（占用/权限）就算了，下次启动还会来 */
      }
    }
    if (removed.length) {
      log.warn(`清理过期错误记录：删了 ${removed.length} 个文件（保留最近 ${days} 天，最早 ${removed[removed.length - 1]}）`)
    }
    return { ok: true, removed, kept: days2.length - removed.length }
  } catch (error) {
    /* 清理失败绝不影响启动 —— 它只是省空间，不是功能 */
    log.warn(`清理过期错误记录失败：${error instanceof Error ? error.message : error}`)
    return { ok: false, removed: [], kept: 0, reason: String(error) }
  }
}

module.exports = { prune, KEEP_DAYS, FILE_RE }
