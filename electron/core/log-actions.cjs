/**
 * 动作流（`data/logs/actions-YYYY-MM-DD.jsonl`）
 *
 * 和 `log.cjs` 的分工：
 *   · `log.cjs`   —— 人看的**主日志**（叙事、成因、结论）
 *   · 这里        —— 机器看的**动作流水**：界面点了什么、调了哪个通道、成没成、多久
 *
 * ── 为什么要单独一份 ──────────────────────────────────────────
 * 用户提的要求：「日志再详细点，最好把**我们没预料到的事件**也包含进去，
 * 比如用户点了什么功能」。手工埋点做不到「没预料到」—— 只能覆盖我想到的那几个。
 * 所以这里走**兜底**两条路（都在唯一出入口上，绕不过去）：
 *   ① 渲染层所有 IPC 调用（preload 里只有一个 `call()`）
 *   ② 全量点击（渲染层捕获阶段监听一次）
 * 这样「用户点了什么功能」不用逐个埋点，**新加的功能也自动被记上**。
 *
 * ── 三条纪律 ────────────────────────────────────────────────
 * ① **绝不含 payload**：只记通道名 / 元素标签 / 成败 / 耗时。
 *    记了 payload 就等于把会话内容、命令、密钥副本写进日志 —— 那是另一个泄露面。
 * ② **高频通道不进流水**（终端数据每秒几十条），否则一天几十 MB 噪音。
 * ③ **有体积上限**：超了轮转成 `.1`，只留一份 —— 日志不能把磁盘吃光。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const { redact } = require('./redact.cjs')
const log = require('./log.cjs')

/** 单份上限 6MB：超了轮转，只留 `.1`（更旧的那份直接丢） */
const MAX_BYTES = 6 * 1024 * 1024

/** 高频通道不进流水（终端输出、流式分片这类）—— 写进来只会把有用的冲掉 */
const SKIP = new Set([
  'shell:data',
  'shell:write',
  'shell:resize',
  'browser:result',
  'chat:event',
  'chat:confirm',
  'log:action',
])

function fileFor(now = new Date()) {
  return path.join(DIRS.logs, `actions-${log.dayStamp(now)}.jsonl`)
}

function rotateIfNeeded(file, incoming) {
  try {
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    if (size + incoming <= MAX_BYTES) return
    const backup = `${file}.1`
    fs.rmSync(backup, { force: true })
    fs.renameSync(file, backup)
  } catch {
    /* 轮转失败不影响主流程 */
  }
}

/**
 * 记一条动作。
 *
 * @param {{ kind: string, name: string, ok?: boolean, ms?: number, detail?: string }} entry
 *   kind: `click`（用户点了）/ `ipc`（界面调了后端）/ `error`（没预料到的异常）/ `action`
 */
function record(entry) {
  const name = String(entry?.name ?? '').slice(0, 80)
  if (!name || SKIP.has(name)) return
  const row = {
    ts: new Date().toISOString(),
    kind: String(entry?.kind ?? 'action').slice(0, 16),
    name,
    ...(entry?.ok === undefined ? {} : { ok: entry.ok === true }),
    ...(typeof entry?.ms === 'number' ? { ms: Math.round(entry.ms) } : {}),
    ...(entry?.detail ? { detail: String(entry.detail).slice(0, 120) } : {}),
  }
  try {
    fs.mkdirSync(DIRS.logs, { recursive: true })
    const file = fileFor()
    /* 脱敏照样过一遍 —— 万一以后有人手滑把内容塞进 detail */
    const line = `${redact(JSON.stringify(row))}\n`
    rotateIfNeeded(file, line.length)
    fs.appendFileSync(file, line, 'utf8')
  } catch {
    /* 写不进去也不能把主流程弄挂 */
  }
}

module.exports = { record, MAX_BYTES, SKIP }
