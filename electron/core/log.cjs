/**
 * 日志
 *
 * 按天写文件，同时打到控制台（开发时能看见）。
 * 日志只在 data/logs 下，不碰任何系统目录。
 *
 * ── 三件小事，都是「查问题时被坑过」才加的 ──────────────────
 *
 * ① **时间戳带本地时区**（`+08:00` 而不是 `Z`）：
 *    以前写 UTC，查一次线上问题就踩了一次 —— 日志里 `17:12` 看着像「昨天下午」，
 *    其实是「今天凌晨 01:12」（UTC+8），差点把当天的账当成隔夜的旧账排除掉。
 *    ISO + 偏移既能人看又能机器解析，不再需要心算。
 *
 * ② **`tagged(tag)`：让同一件事的几行带同一个短码**：
 *    「哪个会话 / 哪条任务」在日志里以前完全没有 —— 只能靠时间戳把几行凑在一起，
 *    而同时跑着两条对话时这就纯靠猜。现在热路径（对话循环）每行都带
 *    `[sess…1b4ahcnd · task…1ihk]`。
 *
 * ③ **`shortId()`**：id 很长，日志里只留末 6 位 —— 足够区分，又不把行撑爆。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const { redact } = require('./redact.cjs')

/** 本地日期的 `YYYY-MM-DD` —— 文件名也按本地走（写 UTC 的话，凌晨那份会叫「昨天」） */
function dayStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function logFile() {
  return path.join(DIRS.logs, `${dayStamp()}.log`)
}

const pad = (n, width = 2) => String(n).padStart(width, '0')

/**
 * 本地时间 + 时区偏移的 ISO，例如 `2026-09-23T01:12:09.805+08:00`。
 * 纯函数（传入日期便于断言）。
 */
function formatStamp(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${day}T${clock}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** id → 日志里够用的短码（末 6 位） */
function shortId(id) {
  const text = String(id ?? '')
  return text.length <= 6 ? text : text.slice(-6)
}

function write(level, message) {
  /*
   * **日志是 Secret 最常见的泄露口** —— 报错时顺手把整个请求体打出来，
   * 里面就有 Authorization。所有日志统一在这里过一遍脱敏，调用方不用操心。
   */
  const line = `[${formatStamp()}] [${level}] ${redact(String(message ?? ''))}`
  try {
    fs.mkdirSync(DIRS.logs, { recursive: true })
    fs.appendFileSync(logFile(), `${line}\n`, 'utf8')
  } catch {
    /* 日志写不进去也不能把主流程弄挂 */
  }
  if (level === 'ERROR' || level === 'WARN') {
    console.error(line)
  } else if (process.env.NODE_ENV !== 'production') {
    console.log(line)
  }
}

/** 带固定前缀的一组日志（前缀进消息正文，格式与行结构都不变） */
function tagged(tag) {
  const prefix = tag ? `[${tag}] ` : ''
  return {
    info: (msg) => write('INFO', prefix + msg),
    warn: (msg) => write('WARN', prefix + msg),
    error: (msg) => write('ERROR', prefix + msg),
  }
}

module.exports = {
  info: (msg) => write('INFO', msg),
  warn: (msg) => write('WARN', msg),
  error: (msg) => write('ERROR', msg),
  log: (msg) => write('INFO', msg),
  tagged,
  shortId,
  formatStamp,
  dayStamp,
}
