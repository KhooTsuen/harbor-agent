/*
 * 便宜的「文件数」估算 —— 只为把 `scaleMaxFiles` 那条闸门接上活。
 *
 * 待办原本记在 `docs/improvement-checklist.md` 的 A2 第 0 条：
 * 「要接上先解决『怎么便宜地估文件数』」。
 *
 * 为什么不能精确数：**数一遍文件本身就是预检要拦的那种操作**，代价不可控
 * （`scale.cjs` 里那段注释写过）。所以这里只做**两层**估算：
 *   · 工作目录本身直接有几个条目
 *   · 它下面每个子目录（最多看 CAP_DIRS 个）各有多少条目
 * 到 `max` 立刻停 —— 调用方只关心「是不是明显巨大」，不关心具体数字。
 *
 * 因此它是**下界**：只会低估，不会高估。低估 = 闸门偏保守（宁可不拦也不误拦），
 * 这是刻意的方向 —— 这一条只是四条硬拦里的第四条，逃出工作目录 / 批量外联
 * 那两条照旧严。别为了「更准」把它改成全量遍历。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 最多看多少个子目录（再大的树，到这个份上早该拦了） */
const CAP_DIRS = 40

/**
 * 估一个目录下「值得递归操作」的条目量（下界）。
 *
 * @param {string} dir 工作目录
 * @param {{ max?: number, capDirs?: number }} [options] max：到它就停
 * @returns {number|null} 估到的条目数；**读不出来给 null**（不是 0）——
 *   0 会被当成「很小」，那是猜；null 表示「不知道」，闸门因此不成立（如实）
 */
function estimateFiles(dir, { max = 2000, capDirs = CAP_DIRS } = {}) {
  let total = 0
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    total += entries.length
    if (total >= max) return total

    const dirs = entries.filter((entry) => entry.isDirectory()).slice(0, capDirs)
    for (const entry of dirs) {
      try {
        total += fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true }).length
      } catch {
        /* 某个子目录读不了就跳过：反正是下界，少算不致命 */
      }
      if (total >= max) return total
    }
    return total
  } catch {
    return null
  }
}

module.exports = { estimateFiles, CAP_DIRS }
