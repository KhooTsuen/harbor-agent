/**
 * 站点策略查询（扩展侧）
 *
 * ── 为什么查询走主进程而不是扩展自己存 ─────────────────────────
 *
 * 用户 2026-10-20 拍板：策略与审计都在主进程（和 risk/net-policy 同族）。这样
 * 侧边栏按钮与 `edge_*` 工具用的是**同一份**判定 —— 各自存一份必然漂，而漂在这里
 * 的后果是「工具说能用、按钮说不能用」，最没法解释。
 *
 * ── 三件必须守住的事 ───────────────────────────────────────────
 *
 *   1. **不缓存结论**。缓存会让「刚拉黑」在下一次请求前仍然放行 —— 这正是这个
 *      功能最不该出错的地方。每次多花 3~8ms（实测），换「拉黑立刻生效」。
 *   2. **「查不到」一律不放行**（fail-closed）。2026-10-20 用户指出：
 *      以前写的是 fail-open，理由是「主进程不在时根本读不到页面，下一句就会失败」。
 *      那个理由**站不住**：`activeTab` 是持久的（授予后直到导航离开），Harbor 关掉
 *      之后扩展**仍然**读得到那个页面 —— 于是「Harbor 没开」变成了绕过黑名单的
 *      后门，而用户看不到任何提示。
 *      现在把两种情况分开：
 *        · **用户还没配过黑名单**（主进程回 `verified:true` + 空表）→ 放行（默认策略）
 *        · **核实不了**（连不上 / 文件坏 / 文件读不出）→ **拒绝**，并说清原因
 *   3. 被拒时返回**人话**，文案只在 `reason` 为空时才自己拼 —— 用户填了原因
 *      就用他的原话（他写给自己看的）。
 */

/* global chrome */

import { requestHost } from './native.js'

/**
 * 核实不了策略时的统一答复（**不是**放行）。
 *
 * @param {string} why 主进程给的原始原因（可空）
 */
function unverifiable(why) {
  const tail = why ? `（${why}）` : ''
  return {
    allowed: false,
    verified: false,
    host: '',
    blockedBy: '',
    error: `核实不了站点策略${tail} —— 为安全起见先不读也不操作这个页面。确认 Harbor 在运行、策略文件没坏后再试。`,
  }
}

/**
 * 这个 url 能不能读 / 操作。
 *
 * @param {string} url
 * @returns {Promise<{ allowed: boolean, verified: boolean, host: string, blockedBy: string, error: string }>}
 *   `allowed:false` 时 `error` 是**已经写好的人话**（调用方直接展示）；
 *   `verified:false` 表示「不是被拉黑，是压根核实不了」—— 调用方可用它区分措辞。
 */
export async function checkSite(url) {
  const target = String(url ?? '')
  let reply = null
  try {
    reply = await requestHost('site-policy', { url: target })
  } catch (error) {
    return unverifiable(String((error && error.message) || error || ''))
  }
  /* 通道回了失败（Harbor 没开 / 不认识的 kind / 内部错误）→ 同样无法核实 */
  if (!reply || reply.ok !== true) return unverifiable(String((reply && reply.error) || ''))
  /* 主进程说「我读不出自己的策略文件」→ 无法核实 */
  if (reply.verified === false) return unverifiable(String(reply.error ?? ''))

  const host = String(reply.host ?? '')
  if (reply.allowed !== false) return { allowed: true, verified: true, host, blockedBy: '', error: '' }

  const blockedBy = String(reply.blockedBy ?? '') || host
  const reason = String(reply.reason ?? '')
  return {
    allowed: false,
    verified: true,
    host,
    blockedBy,
    error: reason
      ? `这个站点被你拉黑了（${blockedBy}）：${reason}`
      : `这个站点被你拉黑了（${blockedBy}），要读或操作它请先在扩展设置里放行`,
  }
}

/** 设置界面只请求主进程的同一份策略，不在扩展另存权限表。 */
export async function listSites() {
  try {
    const reply = await requestHost('site-policy', { action: 'list' })
    if (reply?.ok !== true || reply.verified !== true) return { ok: false, error: String(reply?.error || '站点策略暂时不可读') }
    return { ok: true, sites: Array.isArray(reply.sites) ? reply.sites : [] }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

export async function setTemporaryBlock(url, minutes = 60) {
  try {
    return await requestHost('site-policy', { action: 'block-temporary', url, minutes })
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

export async function unblockSite(url) {
  try {
    return await requestHost('site-policy', { action: 'unblock', url })
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}
