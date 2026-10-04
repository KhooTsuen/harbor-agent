/**
 * 第 7 项检查：**约束机制自己在不在位**
 *
 * 为什么单独一个文件：`checks.mjs` 已经 291 行，加进去就超 300（第一条检查立刻红）。
 * 这也正好印证拆分的理由 —— 查「单文件 ≤ 300 行」的脚本自己先撞线。
 *
 * 查三件事（都是**警告**，不是 error）：
 *   ① `.github/hooks/pre-commit` / `pre-push` / `commit-msg` 在不在
 *   ② `git config core.hooksPath` 有没有指到 `.github/hooks`
 *   ③ `scripts/check-rules.mjs` 在不在（这个文件本身）
 *
 * 为什么用警告：新克隆的仓库还没跑安装脚本，报 error 会让人以为代码坏了。
 * 想装：`node scripts/hooks/install.mjs`。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const WANT_PATH = '.github/hooks'

/** 必须在位的钩子。★ 这份名单是**唯一真相源**：`scripts/hooks/install.mjs` 也 import 它 */
export const HOOKS = ['pre-commit', 'pre-push', 'commit-msg']

export function checkHooksInstalled(root) {
  const warnings = []

  const missing = HOOKS.filter((name) => !fs.existsSync(path.join(root, WANT_PATH, name)))
  if (missing.length > 0) {
    warnings.push(`约束机制少文件：${WANT_PATH}/ 下没有 ${missing.join('、')} —— 检查是不是被删了`)
  }

  let actual = null
  try {
    actual = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    actual = null /* 没设过 → git 报 1，或不在 git 仓库里 */
  }
  if (actual !== WANT_PATH) {
    warnings.push(
      `git 钩子没装：core.hooksPath = ${actual || '（没设）'}，应为 ${WANT_PATH} → 跑 node scripts/hooks/install.mjs`,
    )
  }

  const runner = path.join(root, 'scripts', 'check-rules.mjs')
  if (!fs.existsSync(runner)) warnings.push('scripts/check-rules.mjs 不在 —— 规范检查没得跑')

  const ok = missing.length === 0 && actual === WANT_PATH
  return {
    errors: [],
    warnings,
    summary: ok ? '钩子已装' : `${warnings.length} 处待处理`,
  }
}
