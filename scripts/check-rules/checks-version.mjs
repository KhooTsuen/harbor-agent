/*
 * 检查：改了代码就必须升版本号
 *
 * ── 为什么要有这条 ──
 * 用户要求：「每次有修复或更新的时候都要更新一下小版本」。
 * 而 `docs/发布检查.md` 第 6 节**早就写着**通道规矩（小改动走补丁号、新功能走次版本号），
 * 问题是它只在**发版时人工核对**：平时提交忘了升，没人拦 —— 一直要到发版那天才发现，
 * 中间那几十笔提交的版本号全是假的（装机版显示的版本对不上改动，就是这么来的）。
 *
 * ── 为什么 54 组那条自检拦不住 ──
 * `54-version-sync` 钉的是「package.json == CHANGELOG 第一条标题」。
 * 两处**都没动**时它照样通过 —— 它查的是「一致」，查不出「该动没动」。这里补的就是那个缺口。
 *
 * ── 口径（与 发布检查.md 一致）──
 *   · 本次动了 `src/**` 或 `electron/**` → 版本号必须比上一版**更新**（相等或更低都算漏）；
 *   · **预发布号也算数**（2026-10-06 修）：`1.30.0-beta.2` 比 `1.30.0-beta.1` 新，
 *     而 `1.30.0`（正式版）比任何 `1.30.0-beta.N` 都新。
 *     原来只取前三段数字，于是 beta 之间的升级被判成「没升」—— 把 beta 通道整条路堵死，
 *     而本项目真的用过 beta.1…beta.40（见 CHANGELOG）；
 *   · 只动文档 / 测试 / 脚本 / CI → **不要求**升（改文档也要升版本只会制造噪音）；
 *   · 拿不到 git 历史（浅克隆、不在仓库里）→ 跳过，**不误报**。
 *
 * ── 两种运行时机，两种比法 ──
 *   ① pre-commit（HEAD 还是上一笔、改动在工作区）：比「工作区 vs HEAD」；
 *   ② CI / 已提交（树是干净的）：比「HEAD vs HEAD~1」。
 *   两者都要，否则钩子过了、CI 那一份却看不见。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** 代码目录：只有这些才算「改了代码」（口径与硬约束里说的「改代码」一致） */
const CODE_DIRS = /^(src|electron)\//

/** `1.21.0` / `1.30.0-beta.2` → `{ num: [1,21,0], pre: 'beta.2' }`；不是版本号就 null */
function semver(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? ''))
  if (!m) return null
  return { num: [Number(m[1]), Number(m[2]), Number(m[3])], pre: String(m[4] ?? '') }
}

/**
 * a 是否比 b 新；任一边不是版本号就返回 null（表示「判不了」，别当成 false）。
 *
 * 数字段相同时要看预发布号 —— 这条是 2026-10-06 补的：
 *   · `1.30.0-beta.2` **>** `1.30.0-beta.1`（同类预发布，比数字）
 *   · `1.30.0` **>** `1.30.0-beta.9`（正式版比任何预发布都新）
 *   · `1.30.0-alpha.9` < `1.30.0-beta.1`（不同名按字典序，正好符合 alpha < beta < rc）
 */
function isNewer(a, b) {
  const left = semver(a)
  const right = semver(b)
  if (!left || !right) return null

  for (let i = 0; i < 3; i += 1) {
    if (left.num[i] !== right.num[i]) return left.num[i] > right.num[i]
  }

  if (!left.pre && !right.pre) return false
  if (!left.pre) return true
  if (!right.pre) return false

  const parts = (pre) => {
    const [name, n] = pre.split('.')
    return { name, n: Number(n ?? 0) }
  }
  const l = parts(left.pre)
  const r = parts(right.pre)
  if (l.name !== r.name) return l.name > r.name
  return l.n > r.n
}

export function checkVersionBump(root = process.cwd()) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
        .split(/\r?\n/)
        .filter(Boolean)
    } catch {
      return null
    }
  }

  /** 读某个提交里的 package.json 版本；`null` 表示「工作区那一份」 */
  const versionAt = (rev) => {
    try {
      const raw =
        rev === null
          ? readFileSync(path.join(root, 'package.json'), 'utf8')
          : execFileSync('git', ['show', `${rev}:package.json`], { cwd: root, encoding: 'utf8' })
      return JSON.parse(raw).version
    } catch {
      return null
    }
  }

  /* ① 有待提交的改动（pre-commit 那一刻就是这个状态）*/
  const dirty = [
    ...(git(['diff', '--name-only', 'HEAD']) ?? []),
    ...(git(['ls-files', '--others', '--exclude-standard']) ?? []),
  ]

  let files = dirty
  let oldVersion
  if (dirty.length > 0) {
    oldVersion = versionAt('HEAD')
  } else {
    /* ② 树是干净的（CI / 已提交）：比 HEAD 与它的上一个提交 */
    const between = git(['diff', '--name-only', 'HEAD~1', 'HEAD'])
    if (between === null) {
      return { errors: [], warnings: ['拿不到上一个提交（浅克隆或还没有历史？）—— 这项跳过'], summary: '跳过' }
    }
    files = between
    oldVersion = versionAt('HEAD~1')
  }

  const code = files.filter((f) => CODE_DIRS.test(f))
  if (code.length === 0) {
    return { errors: [], warnings: [], summary: '没动 src/ electron/，不要求升版本' }
  }

  const newVersion = versionAt(null)
  if (!newVersion) {
    return { errors: ['读不到 package.json 的 version —— 这项判不了'], warnings: [], summary: '无法判断' }
  }

  const bumped = isNewer(newVersion, oldVersion)
  if (bumped === null) {
    return {
      errors: [],
      warnings: [`拿不到旧版本号（工作区 ${newVersion}，旧值 ${oldVersion ?? '读不到'}）—— 这项跳过`],
      summary: '跳过',
    }
  }
  if (bumped) return { errors: [], warnings: [], summary: `${oldVersion} → ${newVersion}` }

  const sample = code.slice(0, 3).join('、')
  return {
    errors: [
      `改了代码却没升版本号：本次动了 ${code.length} 个源文件（${sample}${code.length > 3 ? ' 等' : ''}），` +
        `但 package.json 还是 ${newVersion}（上一版 ${oldVersion ?? '读不到'}）`,
      '按 `docs/发布检查.md` 的通道规矩：小改动 → 补丁号 +1（1.22.0 → 1.22.1）；新功能 → 次版本号 +1（1.22.0 → 1.23.0）',
      '并且要在 CHANGELOG.md 最上面加一条**同版本号**的记录（自检 54 组会核对两处一致）',
    ],
    warnings: [],
    summary: `未升（还是 ${newVersion}）`,
  }
}
