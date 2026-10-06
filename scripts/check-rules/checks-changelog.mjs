/*
 * 检查：改了代码就必须写 CHANGELOG
 *
 * ── 为什么口径变了（2026-10-07，硬约束 10 改写）──
 * 原口径是「改了 `src/**` / `electron/**` 就必须升 `package.json` 的版本号」。
 * 它解决了当时那个问题（提交忘了升、发版才发现），但代价是把**版本号变成了提交计数器**：
 * CHANGELOG 攒到 234 个版本段、一天发过 16 个 beta，其中 `beta.4` … `beta.10` 七版
 * 连 tag 都没建（版本号升了、代码提交了、Release 一个没有，见 `scripts/check-release.mjs`）。
 * 版本号本来是**发布事件**，当提交计数器用，两头都不准。
 *
 * 新口径：**改了代码就必须动 `CHANGELOG.md`**（这一笔写进顶部的 `## [未发布]` 段）；
 * 版本号只在**发布**时升 —— 把 `[未发布]` 改名成 `## [x.y.z] — 日期` + 升 `package.json` + 打 tag。
 * 可追溯的粒度保住了（每次提交都有一笔），版本号回到了它的频率上。
 *
 * ── 边界（和原口径一致的部分）──
 *   · 只动文档 / 测试 / 脚本 / CI → **不要求**（改文档也要记账只会制造噪音）；
 *   · 拿不到 git 历史（浅克隆、不在仓库里）→ 跳过，**不误报**。
 *
 * ── 两种运行时机，两种比法 ──
 *   ① pre-commit（HEAD 还是上一笔、改动在工作区）：比「工作区 vs HEAD」；
 *   ② CI / 已提交（树是干净的）：比「HEAD vs HEAD~1」。
 *   两者都要，否则钩子过了、CI 那一份却看不见。
 */

import { execFileSync } from 'node:child_process'

/** 代码目录：只有这些才算「改了代码」 */
const CODE_DIRS = /^(src|electron)\//
const CHANGELOG = 'CHANGELOG.md'

export function checkChangelogChange(root = process.cwd()) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
        .split(/\r?\n/)
        .filter(Boolean)
    } catch {
      return null
    }
  }

  /* 还没有任何提交（HEAD 不存在）→ 没有「上一笔」可比，跳过。
     不这么做的话，未跟踪文件会让下面的 dirty 非空，第一次提交就被自己的检查拦住。 */
  if (git(['rev-parse', '--verify', 'HEAD']) === null) {
    return { errors: [], warnings: ['还没有提交（没有 HEAD）—— 这项跳过'], summary: '跳过' }
  }

  /* ① 有待提交的改动（pre-commit 那一刻就是这个状态）：比「工作区 vs HEAD」 */
  const dirty = [
    ...(git(['diff', '--name-only', 'HEAD']) ?? []),
    ...(git(['ls-files', '--others', '--exclude-standard']) ?? []),
  ]

  let files
  if (dirty.length > 0) {
    files = dirty
  } else {
    /* ② 树是干净的（CI / 已提交）：比 HEAD 与它的上一个提交 */
    const between = git(['diff', '--name-only', 'HEAD~1', 'HEAD'])
    if (between === null) {
      return { errors: [], warnings: ['拿不到上一个提交（浅克隆或还没有历史？）—— 这项跳过'], summary: '跳过' }
    }
    files = between
  }

  const code = files.filter((file) => CODE_DIRS.test(file))
  if (code.length === 0) {
    return { errors: [], warnings: [], summary: '没动 src/ electron/，不要求写 CHANGELOG' }
  }

  if (files.includes(CHANGELOG)) {
    return { errors: [], warnings: [], summary: `${code.length} 个源文件 + CHANGELOG` }
  }

  const sample = code.slice(0, 3).join('、')
  return {
    errors: [
      `改了代码却没动 CHANGELOG：本次动了 ${code.length} 个源文件（${sample}${code.length > 3 ? ' 等' : ''}），` +
        `但 ${CHANGELOG} 一个字没改`,
      `把这一笔写进 ${CHANGELOG} 顶部的 \`## [未发布]\` 段（没有就新建一个）：` +
        '说明**为什么**改、验证数字（改前 / 改后）、诚实写遗留',
      '**版本号不用动** —— 它只在发布时升：把 `[未发布]` 改名成 `## [x.y.z] — 日期` + 升 package.json + 打 tag' +
        '（见 `docs/发布检查.md`）',
    ],
    warnings: [],
    summary: '未写 CHANGELOG',
  }
}
