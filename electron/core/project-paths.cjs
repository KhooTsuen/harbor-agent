/**
 * 项目：路径与命名规范（纯函数，无副作用）
 *
 * 从 `projects.cjs` 拆出来的 —— 那边加完「迁移」就过 300 行了（硬约束 #2）。
 * 按职责切：**这里只回答「目录怎么写才算同一个项目」**，注册表的增删改查在那边。
 *
 * ⚠️ 这个文件**不许 require 其它内核模块**（尤其不许 require `session.cjs`）——
 *    `session-read.cjs` 要引它的 `dirIdFor`，一旦这里反向引回去就成环。
 */

const path = require('node:path')

/**
 * 目录 → 项目 id。
 *
 * ★ **必须与前端 `src/stores/app/disk.ts` 的 `folderIdFor` 逐字一致** ——
 *   老会话（meta 里只有 workdir）靠它推导归属，算出来不一样的话，升级瞬间
 *   用户的对话就会从原来的项目里「搬家」。
 */
function dirIdFor(workdir) {
  return `dir:${String(workdir ?? '')}`
}

/**
 * 比较用的规范化：Windows 不区分大小写，尾部分隔符也不算数。
 * 不这么做的话 `E:\foo` 和 `e:\foo\` 会被当成两个项目，侧栏里就出现两条一模一样的。
 */
function canon(workdir) {
  const normalized = path.normalize(String(workdir ?? '')).replace(/[\\/]+$/, '')
  if (!normalized || normalized === '.') return ''
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** 目录最后一段当默认名字（根目录就整条路径，空的话给一句人话） */
function nameOf(workdir) {
  const text = String(workdir ?? '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
  return text.split('/').filter(Boolean).pop() || text || '未命名项目'
}

/** 用户手建项目的 id：与目录无关，所以改名 / 移动都不影响它 */
function newProjectId(now = Date.now()) {
  return `proj_${now.toString(36)}${Math.random().toString(36).slice(2, 9)}`
}

module.exports = { dirIdFor, canon, nameOf, newProjectId }
