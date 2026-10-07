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

/**
 * 探一个**具体路径**的规模（P4-1：按实际规模判，不按命令形态）。
 *
 * 和 `estimateFiles` 的区别（**两个口径、两个用途，别混**）：
 *   · `estimateFiles` 是**两层下界**，喂「工作目录」那条闸门（够便宜就行）；
 *   · 这里是**有界递归**——因为要判「这个目标的递归操作到底多大」，两层下界会
 *     严重低估：`C:\Users` 两层只有百来个条目，递归却有十几万，两层口径会把它
 *     当「小」放行 —— 那正是这一层最该拦的东西（安全方向是**宁可多问**）。
 *
 * 但递归数**本身不能失控**，所以数到 `max` 立刻停（`C:\Users` 这种很快就撞线，
 * 代价可控），只有**完整走完**且没超 `max` 才报 `known`。
 *
 * @returns {number|null} 条目数；**读不出来给 null**（不存在 / 没权限 / 是 glob 写法
 *   `C:\data\*`），**没走完就给 null**（撞了目录上限）—— 调用方据此保守处理
 *   （**不知道就别放行**，这是安全方向）。
 */
function probeSize(target, { max = 2000, capDirs = 200 } = {}) {
  try {
    if (!fs.statSync(target).isDirectory()) return 1
  } catch {
    return null
  }
  let count = 0
  let dirs = 0
  const stack = [target]
  while (stack.length > 0) {
    /* 目录数也设上限：一条命令指向的目录极多时，宁可说「不知道」（→ 拦） */
    if (dirs >= capDirs) return null
    const dir = stack.pop()
    dirs += 1
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    count += entries.length
    if (count >= max) return count
    /* 只进真目录（`Dirent.isDirectory()` 对符号链接是 false，因此不会跟着链接绕圈） */
    for (const entry of entries) if (entry.isDirectory()) stack.push(path.join(dir, entry.name))
  }
  return count
}

/**
 * 探一组路径，取**最大**的那个（一条命令可能挂多个目标）。
 * 有**任何一个**探不出来就整体作废（`known: false`）—— 一处说不清，整条就按「不知道」算。
 *
 * @returns {{ known: boolean, files: number|null }}
 */
function probePaths(paths, options = {}) {
  const list = Array.isArray(paths) ? paths.filter((one) => String(one ?? '').trim()) : []
  if (list.length === 0) return { known: false, files: null }
  let biggest = 0
  for (const one of list) {
    const n = probeSize(one, options)
    if (n === null) return { known: false, files: null }
    if (n > biggest) biggest = n
  }
  return { known: true, files: biggest }
}

module.exports = { estimateFiles, probeSize, probePaths, CAP_DIRS }
