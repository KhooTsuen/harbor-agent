/*
 * AG-010：中断（Stop）的共用零件。
 *
 * 为什么单独一个文件：不止一条链路要干同样两件事 ——「这个 signal 断了吗」和
 * 「把一个进程连同它的子进程一起弄死」。以前这两件事散在各处各写一遍，
 * 于是就有了两个真实存在的洞（都实测过）：
 *
 *   ① child.kill() 在 Windows 上只杀直接子进程。run_shell 起的是 cmd.exe，
 *      真正干活的 ping.exe 是它的儿子 —— cmd 死了以后孙子会变孤儿继续跑。
 *      文档要求「子进程能够终止」，这条就是没做到。
 *   ② exec 的 callback 要等**输出管道关掉**才来。中断之后又等了 29.6 秒
 *      （命令自然跑完）才 resolve —— 用户点了停止还得瞪半分钟。
 *      所以中断必须能**抢在正常完成之前**把 Promise 结掉。
 */

const { spawn } = require('node:child_process')

/** signal 断了吗。全仓统一走这个，别处不要各自写 `signal?.aborted` */
function isAborted(signal) {
  return signal?.aborted === true
}

/**
 * 把一个进程连同它的子进程一起弄死。
 *
 * Windows 上走 `taskkill /T`（T = 连同子树）；类 Unix 走 SIGKILL 到进程组，
 * 退一步给进程本身。**故意用 spawn 而不是 execSync** —— 杀进程不值得我们
 * 再卡一次主进程，调用方要的是「立刻结算」，不是「确认杀干净了」。
 *
 * 传 null / undefined 安全（`onAbort` 可能在 child 还没赋值时就触发）。
 */
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).unref()
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  } catch {
    /* 进程可能已经不在了 */
  }
}

/**
 * 挂一次性 abort 监听，返回摘除函数。
 * 正常完成时**一定要摘**，否则一个长会话会挂上几百个监听器。
 * signal 已经断了的话立刻执行 fn（幂等，交给调用方的结算器去判重）。
 */
function onAbort(signal, fn) {
  if (!signal) return () => {}
  if (signal.aborted) {
    fn()
    return () => {}
  }
  signal.addEventListener('abort', fn, { once: true })
  return () => signal.removeEventListener('abort', fn)
}

/**
 * 「谁先到算谁」的结算器 —— 包一个 Promise 的 resolve。
 * 返回的函数重复调用只会生效第一次，返回 true 表示「这次是我结的」。
 */
function createSettler(resolve) {
  let settled = false
  return (value) => {
    if (settled) return false
    settled = true
    resolve(value)
    return true
  }
}

module.exports = { isAborted, killTree, onAbort, createSettler }
