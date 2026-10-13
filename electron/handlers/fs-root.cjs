/**
 * 文件系统 IPC 的「根」与访问范围
 *
 * 从 `fs.cjs` 拆出来的（那边 288 行、贴着 300 红线），而这一块自成一体：
 * 「哪个目录算根 / 给来的根认不认 / 路径怎么解析 / 越界怎么挡」全在这里。
 *
 * ★ 为什么非拆不可（2026-10-13 用户真机报的 bug）：
 *   同一份 handler 里，**列树**和**读文件**以前用了两个不同的根 ——
 *   `fs:tree` 认「这条对话自己的目录」（渲染层传的 requested），
 *   而 `fs:read` / `fs:list` / `fs:reveal` 一律按**全局** `workdir()` 解析；
 *   `buildTree` 算相对路径用的也是全局那个。
 *   后果：只要「对话自己的目录」≠「全局工作目录」，右栏就**列得出来、点开读不了**，
 *   报的还是句让人看不懂的话（「只能访问工作目录里的内容。工作目录是：<全局目录>」）。
 *   现在根**显式贯穿**：谁列树，谁把同一个根传回来。
 *
 * ★ 安全边界**没有放宽**（写清楚，免得后人以为这里松了）：
 *   能当「根」的只有应用自己认得的那几个目录 —— 全局工作目录、默认 workspace/chat、
 *   以及**已有对话挂过的目录**（`core/session.cjs` 的 `workdirs()`）。
 *   别的绝对路径一律回落到全局工作目录，并记一条 warn。
 *   往上级跑（`..`）照旧挡着。
 *   ⚠️ 这**不是**「防住被攻破的渲染层」那种边界（渲染层本来就能通过 `shell:run` 跑命令），
 *     它防的是「随手一个相对路径把整块磁盘摊开」—— 与 `fs.cjs` 文件头说的是同一件事。
 */

const fs = require('node:fs')
const path = require('node:path')
const config = require('../core/config.cjs')
const log = require('../core/log.cjs')

/** 全局工作目录：用户配过且还在就用它，否则用自带的 workspace */
function workdir() {
  const configured = config.get().general.workdir
  if (configured && fs.existsSync(configured)) return configured
  const { DIRS } = require('../core/paths.cjs')
  fs.mkdirSync(DIRS.workspace, { recursive: true })
  return DIRS.workspace
}

/** 比路径用的归一化 —— Windows 不区分大小写，不做这一步同一个目录会被当成两个 */
function norm(dir) {
  const resolved = path.resolve(String(dir))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 允许当「根」的目录集合（见文件头 ★）。
 *
 * 会话目录从 `session.workdirs()` 现取（一次小的索引读，只在**传了 root 且不是全局根**时才走）。
 * 任何一步失败都只是少几个候选根 —— 不因为一个可选根把预览功能打挂。
 */
function allowedRoots() {
  const roots = new Set()
  const push = (dir) => {
    if (typeof dir === 'string' && dir.trim()) roots.add(norm(dir))
  }
  push(workdir())
  try {
    const { DIRS } = require('../core/paths.cjs')
    push(DIRS.workspace)
    push(DIRS.chat)
  } catch {
    /* 路径模块读不到就算了 */
  }
  try {
    for (const entry of require('../core/session.cjs').workdirs()) push(entry && entry.workdir)
  } catch {
    /* 没有会话 / 会话坏了 → 只剩全局那几个根 */
  }
  return roots
}

/**
 * 把渲染层给来的根归一化。
 * 不认识 / 不存在 / 没给 → 回落到全局工作目录（= 改之前的行为，向后兼容）。
 */
function rootOf(requested) {
  const asked = typeof requested === 'string' ? requested.trim() : ''
  if (!asked) return workdir()
  let resolved
  try {
    resolved = path.resolve(asked)
  } catch {
    return workdir()
  }
  if (fs.existsSync(resolved) && allowedRoots().has(norm(resolved))) return resolved
  log.warn(`fs: 不接受这个根（回落全局工作目录）：${resolved}`)
  return workdir()
}

/** 把用户给的相对路径解析到 `root` 下，并挡掉往上级跑 */
function resolveInside(input, root = workdir()) {
  const raw = String(input ?? '').trim()
  if (!raw) return root

  const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw)
  const rel = path.relative(root, absolute)

  /* rel 以 .. 开头说明跑到根外面了 */
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`只能访问工作目录里的内容。工作目录是：${root}`)
  }
  return absolute
}

module.exports = { workdir, rootOf, resolveInside, allowedRoots }
