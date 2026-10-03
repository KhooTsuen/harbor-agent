/**
 * 「这次要不要先建最小验证」—— 只在新活第一轮注入的那一句话
 *
 * ── 缺的是什么 ──
 * 用 Harbor 做**新项目**时，「先建一个最小验证」是「想到了才做」，不是流程的一部分；
 * 而改 Harbor 自己时恰好相反：verify 链是现成的，缺的只是「去跑」。
 * 所以两种项目要**两种口径**，判据是磁盘上有没有测试入口 —— 不是靠模型记得。
 *
 * ── 可检查性（这一条是它存在的理由）──
 * 「提醒」最容易变成噪音或说教，所以三个边界都写进自检（`113-verify-hint`）：
 *   ① 没有测试入口 → 要求**先建**（并说清是什么形态）；
 *   ② 有测试入口 → 给出**那条命令**，而且**不许**再要求新建（不许误报）；
 *   ③ 已经有未完成任务台账时（不是新活第一轮）→ **不注入**（每轮都喊就是噪音）。
 *
 * ── 预算与截断（硬禁区 12 要的那两条）──
 *   · 预算：**≤ 400 字符**，超了从头截断（`MAX_CHARS`）；
 *   · 注入位置：`taskState` 层（和任务台账同层，**没有新增层**），
 *     超限时仍由 `context-builder.cjs` 按 `budget.task` 截断；
 *   · 纯文本，没有多模态内容，不会出现「切坏图片」那类问题。
 *
 * 识别测试入口复用 `workspace-summary.cjs` 的 `testCommandOf`（那边是**唯一**来源，
 * 开屏总览用的也是它，别在这儿抄第二份）。
 *
 * 已知边界（**故意**不做的）：只认 `npm test` / `cargo test` / `go test` 三种；
 * 没有 `scripts.test` 的 JS 项目（只装了 vitest 但没写脚本）会被判成「没有入口」。
 * 宁可漏认也不去猜 —— 猜错会让模型以为有现成的验证可跑。
 */

const fs = require('node:fs')
const path = require('node:path')
const { testCommandOf } = require('./workspace-summary.cjs')

/** 注入上限（字符）。超了截断，不扩容 —— 这是每轮都要进提示的东西 */
const MAX_CHARS = 400

/**
 * 这个目录有没有现成的测试入口。
 *
 * @param {string} workdir
 * @returns {{ command: string, name: string }}
 */
function testEntry(workdir) {
  const dir = String(workdir ?? '')
  if (!dir) return { command: '', name: '' }
  /* 目录都不在就别出口径了 —— 对着一个不存在的目录要求「先建最小验证」只会误导 */
  try {
    if (!fs.statSync(dir).isDirectory()) return { command: '', name: '' }
  } catch {
    return { command: '', name: '' }
  }
  let command = ''
  try {
    command = testCommandOf(dir)
  } catch {
    /* 读不动就当成「没有入口」—— 这时要求先建一个，不会害人 */
    command = ''
  }
  return { command, name: path.basename(dir) }
}

/** 有入口：给命令 + 要基线；不要再说「先建」 */
function withEntry(command) {
  return [
    '## 动手之前先跑一次验证',
    `这个项目有现成的测试入口：\`${command}\`。`,
    '先跑一遍拿到「改之前是什么样」这个基线，改完再跑一遍对比 ——',
    '别只靠眼看（这个项目吃过「测试全绿但功能是坏的」的亏）。',
  ].join('\n')
}

/** 没有入口：要求先建一个最小验证，说清形态（一条命令就能跑） */
function withoutEntry(name) {
  return [
    '## 先建最小验证（这个目录还没有测试入口）',
    `动手改代码之前，先做一个**一条命令就能跑起来**的最小验证（一个只覆盖你要改的那一点的小用例即可），${name ? `放在 ${name} 里` : ''}`,
    '把「改坏了」当场变成可见的红，而不是一路改到底再回头看。',
  ].join('\n')
}

/**
 * 生成要拼进 `taskState` 的那一段。**没有 workdir 就返回空串**（不注入一个空标题）。
 *
 * @param {{ workdir?: string }} [options]
 */
function build({ workdir = '' } = {}) {
  const entry = testEntry(workdir)
  if (!entry.name) return ''
  const text = entry.command ? withEntry(entry.command) : withoutEntry(entry.name)
  return text.slice(0, MAX_CHARS)
}

module.exports = { build, testEntry, MAX_CHARS }
