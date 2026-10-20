/**
 * 会话列表的**启动快路径**
 *
 * ── 为什么单独一个文件（2026-10-20）──────────────────────────
 * `session-read.cjs` 贴着 300 行红线，而这一块和「读一条会话」是两件事：
 * 那边管「一条会话怎么读」，这边管「启动时怎么读得快」。
 *
 * ── 它解决什么 ──────────────────────────────────────────────
 * 用户报「打开软件卡 20 秒 + 软件暂时无响应」。实测开发版有个 **141 MB**
 * 的会话（1100 条消息），而列表为了显示标题与条数要把每个文件整篇读进来
 * 逐行解析 —— 10 个这样的会话串起来是 21.9 秒的**同步**执行，
 * 期间事件循环全程被占死，界面表现为「点了没反应」。
 *
 * 两步一起做：
 *   ① **只读首行**拿 meta（`session-meta-slot`，每个会话 4KB）；
 *   ② **不数消息条数** —— 那一步要整篇读（单个大会话 2.9 秒，且无法中途
 *      打断）。启动给 0，缓存里有真值时就带上。实测 7 ms 出列表。
 *
 * ── 为什么 messageCount 可以先给 0 ───────────────────────────
 * 它**不进侧栏显示**（实测扫过渲染层：只有诊断报告与扩展桥读它）。
 * 诊断报告与扩展桥走的都是同步 `list()`，那里始终是真实值。
 *
 * ── 纪律 ────────────────────────────────────────────────────
 * 列表项只由 `session-read.listOne` 产出，排序也同一套（`updatedAt` 倒序）。
 * 这里不重新拼形状 —— 两处各拼一套正是本项目栽过四次的那类事故。
 */
const fs = require('node:fs')
const { DIRS } = require('./paths.cjs')
const { isSessionId } = require('./session-io.cjs')
const { listOne } = require('./session-read.cjs')

/**
 * 启动用的列表：**只读首行**、不算条数，算完立刻返回。
 *
 * ★ 不启动后台补条数（2026-10-20 实测）：补一条 141 MB 的会话要 2.9 秒
 *   **不可分割的同步块**，用户会先看到列表秒出、随后又卡住 3 秒 —— 等于把
 *   卡顿推迟了。`messageCount` 只在同步 `list()`（诊断报告 / 扩展桥）里算，
 *   侧栏不显示它，所以这里给 0 完全够用；缓存里有值时就带上真值。
 *
 * @returns {Promise<Array>} 形状与 `session-read.list()` 相同（`messageCount` 可能为 0）
 */
function listFast() {
  const items = []
  for (const id of sessionIds()) {
    const item = listOne(id, { skipCount: true })
    if (item) items.push(item)
  }
  return Promise.resolve(items.sort((a, b) => b.updatedAt - a.updatedAt))
}

function sessionIds() {
  if (!fs.existsSync(DIRS.sessions)) return []
  return fs
    .readdirSync(DIRS.sessions)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.slice(0, -'.jsonl'.length))
    .filter((id) => isSessionId(id))
}

module.exports = { listFast }

