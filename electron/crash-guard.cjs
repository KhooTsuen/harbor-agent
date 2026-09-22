/**
 * 主进程的异常兜底
 *
 * 在 `main.cjs` **最前面**装上 —— 装晚了就抓不到启动阶段的异常。
 *
 * ★ 为什么必须记：主进程里一个没捕获的异常，以前的表现是
 *   「窗口还在、功能不对，而 data/logs 里一个字都没有」—— 最难查的那种。
 *   现在至少留下一行 + 一条动作流水，和「用户点了什么」能对上时间。
 *
 * ★ 策略：**记下来，然后继续跑**。
 *   Node 默认遇到未捕获异常会退出进程 —— 那会把用户没保存的东西一起带走，
 *   对这个应用来说代价太大。宁可留下线索、让它继续（真崩到不能用了，
 *   用户会看到界面异常，而日志里有那一行）。
 */

const log = require('./core/log.cjs')
const actions = require('./core/log-actions.cjs')

const MAX_STACK = 800

function detailOf(error) {
  if (error instanceof Error) return `${error.message}\n${error.stack ?? ''}`.slice(0, MAX_STACK)
  if (typeof error === 'string') return error.slice(0, MAX_STACK)
  try {
    return JSON.stringify(error).slice(0, MAX_STACK)
  } catch {
    return String(error).slice(0, MAX_STACK)
  }
}

function installCrashGuard() {
  process.on('uncaughtException', (error) => {
    const detail = detailOf(error)
    log.error(`主进程未捕获异常：${detail}`)
    actions.record({ kind: 'error', name: 'main:uncaughtException', ok: false, detail })
  })

  process.on('unhandledRejection', (reason) => {
    const detail = detailOf(reason)
    log.error(`主进程未处理的 Promise 拒绝：${detail}`)
    actions.record({ kind: 'error', name: 'main:unhandledRejection', ok: false, detail })
  })
}

module.exports = { installCrashGuard }
