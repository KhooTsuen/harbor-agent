/**
 * 误跟踪检查：**已经进了 Git 的文件，后面再加 .gitignore 是拦不住的**
 *
 * 这是本项目反复踩的同一类坑：`.gitignore` 只管「新增时要不要跟踪」，
 * 一个文件一旦被 `git add` 进去，之后往 `.gitignore` 里写规则它照样留着 ——
 * 必须显式 `git rm --cached` 才退出跟踪。
 *
 * ── 两条判据（都是保守的，宁可不报也不误伤）──────────────
 *
 *   ① `git ls-files -i -c --exclude-standard`
 *      由 git 自己算：**被跟踪 + 匹配忽略规则**的交集。零误伤，
 *      因为它用的就是 .gitignore 那一套真规则。
 *   ② 文件名以 `tmp-` / `tmp_` 开头的被跟踪文件。
 *      `.gitignore` 里写了 `tmp-*`，但那是本项目自己的约定 ——
 *      真要放进仓库的脚本不该叫这个名字。命中只是提示，不是判错。
 *
 * ── 为什么是警告不是错误 ─────────────────────────────────
 * 已跟踪的文件不影响构建和测试，它是「仓库越来越乱」的趋势指标。
 * 但它必须被报出来 —— 2026-11-09 那次整理前，`tools/` 下躺着 8 个
 * 别的项目（GazBoard）的 CDP 探针，没有任何测试会说什么。
 *
 * 例外：`tmp/README.md` 是**故意**进仓库的索引（`.gitignore` 里用
 * `!tmp/README.md` 捞回来的），所以第 ② 条放行它。
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'

/** git 拿不到时（比如不是 git 仓库）直接跳过，不当成失败 */
function gitLines(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split(/\r?\n/)
      .filter(Boolean)
  } catch {
    return null
  }
}

/** 故意进仓库的索引文件（`.gitignore` 里用 `!` 捞回来的那几个） */
const ALLOW = new Set([path.join('tmp', 'README.md').replace(/\\/g, '/')])

const FIX_HINT = '退出跟踪但保留本地文件：git rm --cached <文件>（然后确认 .gitignore 里已经有对应规则）'

export function checkTrackedCruft(root) {
  const tracked = gitLines(root, ['ls-files'])
  if (tracked === null) {
    return { errors: [], warnings: ['拿不到 git 列表（不在 git 仓库里？）—— 这项跳过'], summary: '跳过' }
  }

  const warnings = []

  /* ① git 自己算的交集：被跟踪 + 该被忽略 */
  const ignored = gitLines(root, ['ls-files', '-i', '-c', '--exclude-standard']) ?? []
  const bad = ignored.filter((f) => !ALLOW.has(f.replace(/\\/g, '/')))
  if (bad.length > 0) {
    warnings.push(
      `有 ${bad.length} 个文件**已被跟踪但匹配 .gitignore**（新加规则对它们无效）：`,
      ...bad.slice(0, 10).map((f) => `  ${f}`),
      ...(bad.length > 10 ? [`  …还有 ${bad.length - 10} 个`] : []),
      `  ${FIX_HINT}`,
    )
  }

  /* ② 本项目约定的「一次性」命名却进了仓库 */
  const tempNamed = tracked.filter((f) => {
    const norm = f.replace(/\\/g, '/')
    if (ALLOW.has(norm)) return false
    return /(^|\/)tmp[-_]/.test(norm)
  })
  if (tempNamed.length > 0) {
    warnings.push(
      `有 ${tempNamed.length} 个以 tmp- / tmp_ 命名的文件在仓库里（这个名字表示一次性脚本，不该长期留下）：`,
      ...tempNamed.slice(0, 10).map((f) => `  ${f}`),
      `  ${FIX_HINT}`,
    )
  }

  const summary =
    bad.length === 0 && tempNamed.length === 0
      ? `${tracked.length} 个跟踪文件，没有误跟踪`
      : `${bad.length} 个该被忽略 · ${tempNamed.length} 个临时命名`

  return { errors: [], warnings, summary }
}
