/**
 * 「只分析，不修改」那一轮，**只读命令照常放行**（2026-11-06）
 *
 * 为什么需要这个文件：用户的原话是「允许安全的只读检查，但继续阻止未授权写入」。
 * 在此之前那道门是一刀切 —— `ctx.allowWrite === false` 时 `run_shell` 一律被拒，
 * 于是「这一轮只分析」连 `git status` / `dir` / `type` 都跑不了，
 * 而这几条恰恰是**分析本身要用**的工具。用户被自己下的约束堵住了眼睛。
 *
 * ★ 判据**不在这里新写一份**：只读形状的唯一真相源是 `risk-patterns.cjs` 的
 *   `isReadOnlyCommand()`（命令开头在 LOW 名单 + 没有 shell 元字符 + 没有破坏性参数）。
 *   那边已经踩过 `find . -delete` 的坑，别在调用方再"差不多"地判一次（硬约束 9）。
 *
 * ★ 只放行 **`run_shell` 里的只读命令**，别再扩大：
 *   `write_file` / `edit_file` / `download` / `apply_test_fix` 这些即使"看起来很安全"
 *   也一律照拦 —— 那才是「只分析」这句话真正要护住的东西。
 *   `node xxx.mjs` 这类跑脚本的**不算只读**（`LOW` 名单里没有它），照拦。
 */

const { isReadOnlyCommand } = require('../risk-patterns.cjs')

/** 允许在只读轮里跑的写类工具：只有它一个 */
const READONLY_SHELL_TOOLS = new Set(['run_shell'])

/**
 * 这次调用能不能在「只分析」那一轮放行。
 *
 * @param {string} name 工具名
 * @param {Record<string, unknown>} args 调用参数
 * @returns {boolean} true = 这是安全只读检查，可以跑
 */
function allowedInReadonly(name, args) {
  if (!READONLY_SHELL_TOOLS.has(String(name ?? ''))) return false
  const command = String(args?.command ?? '')
  if (!command.trim()) return false
  return isReadOnlyCommand(command)
}

module.exports = { allowedInReadonly, READONLY_SHELL_TOOLS }
