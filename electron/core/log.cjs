/**
 * 日志
 *
 * 按天写文件，同时打到控制台（开发时能看见）。
 * 日志只在 data/logs 下，不碰任何系统目录。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const { redact } = require('./redact.cjs')

function logFile() {
  const day = new Date().toISOString().slice(0, 10)
  return path.join(DIRS.logs, `${day}.log`)
}

function write(level, message) {
  /*
   * **日志是 Secret 最常见的泄露口** —— 报错时顺手把整个请求体打出来，
   * 里面就有 Authorization。所有日志统一在这里过一遍脱敏，调用方不用操心。
   */
  const line = `[${new Date().toISOString()}] [${level}] ${redact(String(message ?? ''))}`
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

module.exports = {
  info: (msg) => write('INFO', msg),
  warn: (msg) => write('WARN', msg),
  error: (msg) => write('ERROR', msg),
  log: (msg) => write('INFO', msg),
}
