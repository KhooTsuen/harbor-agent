/**
 * 流式请求的「空闲看门狗」
 *
 * ★ 为什么需要它（2026-09-25 真机验收）：上游的流会**挂住** —— 请求发出去了、
 *   数据不回来，也不报错。没有这道阀门时，整轮对话永远停在「运行中」，
 *   用户什么都等不到。
 *
 * ★ 为什么是「赛跑」而不是「abort」（同一天的第二次教训）：第一版把超时挂在
 *   AbortController 上 —— 打包版里实测**不生效**（挂住依旧挂住，45 秒到点
 *   什么都没发生）。所以这里不赌底层：`race()` 让「超时」这个 promise
 *   直接先拒绝，abort 只留作最大努力的取消。
 *
 * 与 `http.cjs` 的分工：那边**有意不设总超时**（正常流可以跑几分钟）；
 * 这里管的是**空闲** —— 两次数据之间隔多久算挂住。
 *
 * 报错文案**必须**带 "timeout" 字样 —— `errors.classify` 靠它归类成
 * 可重试的 timeout，交给既有重试/降级链路（loop-model.cjs）。
 */

/** 两个数据块之间最多等多久（首次响应也一样计时） */
const DEFAULT_IDLE_MS = 45_000

function createIdleGuard(idleMs) {
  const ms = Number(idleMs) > 0 ? Number(idleMs) : DEFAULT_IDLE_MS
  const message = `上游 timeout：${Math.round(ms / 1000)} 秒没有返回数据（连接挂住，已放弃这次请求）`
  const controller = new AbortController()
  let timer = null
  let fired = false
  let cancelHook = null
  /** 正在「赛跑」的那些 promise 的 reject 回调 */
  const waiters = new Set()

  const fire = () => {
    fired = true
    /* 最大努力：底层要是理 abort，能省下一次真请求 */
    controller.abort()
    for (const reject of waiters) reject(new Error(message))
    waiters.clear()
    if (typeof cancelHook === 'function') {
      try {
        cancelHook()
      } catch {
        /* 取消失败不影响报错 */
      }
    }
  }

  return {
    /** 打开阀门（每次等网络数据之前调用） */
    arm() {
      clearTimeout(timer)
      timer = setTimeout(fire, ms)
    },
    /** 拿到数据（或不再等了），关掉阀门 */
    stop() {
      clearTimeout(timer)
    },
    /** 超时那一刻额外要做的事（比如取消 reader —— 最大努力，不指望它） */
    onFire(handler) {
      cancelHook = handler
    },
    /**
     * 与一个 promise 赛跑：看门狗先到就抛 timeout 错误。
     * **不依赖底层 abort 是否生效** —— 这是第一版在打包版上翻车的地方。
     */
    race(promise) {
      return new Promise((resolve, reject) => {
        waiters.add(reject)
        promise.then(
          (value) => {
            waiters.delete(reject)
            resolve(value)
          },
          (error) => {
            waiters.delete(reject)
            reject(error)
          },
        )
      })
    },
    /** 与调用方 signal 合成用（AbortSignal.any，最大努力取消） */
    signal: controller.signal,
    timedOut: () => fired,
    message,
  }
}

module.exports = { createIdleGuard, DEFAULT_IDLE_MS }
