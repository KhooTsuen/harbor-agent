/*
 * 外链白名单 —— **唯一一份**（审计问题 18）。
 *
 * 之前 `main.cjs` 的 `setWindowOpenHandler` 里是 `shell.openExternal(url)` 直接开：
 * 聊天里一条 `[点我](file:///C:/Windows/system.ini)` 会渲染成 `<a target="_blank">`，
 * 点下去走的正是这条路 —— 系统**直接打开本地文件**，而这条路径没有任何判据。
 *
 * 为什么必须只有一份：凡是「外抛给系统」的地方都得同一个口径，
 * 写两处一定漂（一处加了白名单、另一处忘 → 洞还在）。
 *
 * 刻意**不** require('electron')（同 `navigation-policy.cjs`）：shell 由调用方注入，
 * 这样自检与单测在没有 Electron 的环境里也能**真跑**（而不是抠源码字符串）。
 */
const log = require('./log.cjs')

/** 允许交给系统打开的协议。其余一律不打开（`file:` / `javascript:` / `data:` …） */
const ALLOWED_SCHEMES = ['http:', 'https:', 'mailto:']

/** 取协议（小写）。取不到（空、非字符串、不是 URL）返回空串 —— 当作不允许 */
function schemeOf(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  try {
    return new URL(raw).protocol.toLowerCase()
  } catch {
    return ''
  }
}

/** 这个地址该不该交给系统打开 */
function isOpenableExternal(raw) {
  return ALLOWED_SCHEMES.includes(schemeOf(raw))
}

/** 日志里最多放这么长（地址可能很长也可能带 token —— 日志本身还会再脱敏一遍） */
const LOG_MAX = 120

/**
 * 放行 → 交给系统；否则**只记一笔，什么都不做**。
 *
 * @param {{ openExternal?: (url: string) => unknown }} shell 注入的 electron shell
 * @param {unknown} raw 想打开的地址
 * @param {string} [where] 调用点名字，进日志方便定位
 * @returns {boolean} 是否真的交出去了
 */
function openExternalSafe(shell, raw, where = '') {
  const at = where ? ` [${where}]` : ''
  const got = schemeOf(raw)
  if (!ALLOWED_SCHEMES.includes(got)) {
    const tail = raw === undefined || raw === null ? String(raw) : String(raw).slice(0, LOG_MAX)
    log.warn(`拒绝打开外部链接${at}：只放行 ${ALLOWED_SCHEMES.join(' ')}，拿到的是 ${got || tail}`)
    return false
  }
  if (!shell || typeof shell.openExternal !== 'function') {
    log.warn(`没法打开外部链接${at}：shell 不可用`)
    return false
  }
  try {
    void shell.openExternal(raw)
    /*
     * 成功也留一笔（INFO）：用户说「点链接没反应」时，日志要能分清
     * 是「交给系统了」还是「被我们拦了」—— 否则只能靠猜。
     */
    log.info(`打开外部链接${at}：${String(raw).slice(0, LOG_MAX)}`)
    return true
  } catch (err) {
    log.warn(`打开外部链接失败${at}：${err && err.message ? err.message : err}`)
    return false
  }
}

module.exports = { ALLOWED_SCHEMES, schemeOf, isOpenableExternal, openExternalSafe }
