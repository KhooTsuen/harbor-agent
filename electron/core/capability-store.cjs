/**
 * 授权记录的读写（data/capabilities.json）
 *
 * 从 `capability.cjs` 拆出来的第三块（C-1）：那边只剩「这次能不能动」的判断，
 * 这里只管「授权怎么存、怎么加、怎么删、怎么列」。纯判断在 `capability-rules.cjs`。
 *
 * ★ 三条与 C-1 直接相关的规矩，都写在这一层：
 *
 *   ① **读进来不过滤**。旧代码 `filter(g => typeof g.path === 'string')`，
 *      把「看起来不对」的记录直接丢掉 —— 用户会以为授权还在、实际被静默吞了。
 *      现在记录一律留着，能不能用交给 `capability-rules.inspectGrant` 判：
 *      判不过就不放权，但用户还能在审批中心**看见它、撤掉它**。
 *
 *   ② **会话类授权每次都要重算过期时刻**。旧代码「找到同路径同模式的记录就只更新
 *      grantedAt」，于是一条 12 小时前建的 session 授权被重新批准后 `expiresAt`
 *      还是旧的 —— 刚批完就过期（C-1 探针实测读不到文件）。
 *
 *   ③ **once 按「这条记录」删**，不按路径删。旧代码按路径删，别的会话在同一路径
 *      批的 once 会被一起抹掉 = 提前消耗别人的授权。
 */

const fs = require('node:fs')
const path = require('node:path')
const rules = require('./capability-rules.cjs')

/**
 * 一次性授权的存活时长。
 *
 * ★ 为什么一次性也要有到期时刻（而不是 `expiresAt: 0`）：
 *   `expiresAt: 0` 在旧代码里等于「永不过期」——一次「完全访问档顺手放行」
 *   留下的 once 记录如果**始终没被消费**（工具在授权后就没再被调用），
 *   它会一直躺在授权文件里，直到被同路径的下一次调用用掉。给它一个短窗口，
 *   过期就自己失效，符合「一次性」的字面意思。
 *
 *   5 分钟足够走完「授权 → 立刻重试」那一步；历史数据里 `expiresAt: 0` 的
 *   旧 once 记录会被 `inspectGrant` 判成不合格 → 失效 → 逼用户重新批一次。
 *   这是**有意**的保守方向：说不清何时该失效的授权，不算授权。
 */
const ONCE_TTL_MS = 5 * 60 * 1000

/** 会话级授权的存活时长（12 小时，防用户忘了清） */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000

/** 授权记录上限，别让这个文件无限长 */
const MAX_GRANTS = 200

let cache = null

function filePath() {
  return path.join(require('./paths.cjs').DIRS.data, 'capabilities.json')
}

/** 读全部记录（含说不清能不能用的；判不判得过由 inspectGrant 说） */
function all() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'))
    cache = { version: 1, grants: Array.isArray(parsed.grants) ? parsed.grants.filter(Boolean) : [] }
  } catch {
    cache = { version: 1, grants: [] }
  }
  return cache
}

function persist() {
  const data = all()
  fs.mkdirSync(path.dirname(filePath()), { recursive: true })
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2), 'utf8')
}

/**
 * 加一条授权。
 *
 * @param {string} target
 * @param {{ mode?: string, sessionId?: string, reason?: string }} [options]
 * @returns {{ ok: boolean, path?: string, mode?: string, error?: string }}
 */
function add(target, { mode = 'session', sessionId = '', reason = '' } = {}) {
  const data = all()
  const absolute = rules.realpath(target)
  const key = rules.canon(absolute)
  const resolved = rules.modeOf(mode)
  /* 永久授权是用户明确的全权，不绑会话；另外两档必须能说清「谁批的」 */
  const owner = resolved === 'permanent' ? '' : String(sessionId ?? '')
  if (resolved !== 'permanent' && !owner) {
    return { ok: false, error: '会话类授权必须带会话身份', path: absolute, mode: resolved }
  }

  const expiresAt =
    resolved === 'once'
      ? Date.now() + ONCE_TTL_MS
      : resolved === 'session'
        ? Date.now() + SESSION_TTL_MS
        : /* permanent 不设过期，用户明确的全权 */ 0

  const existing = data.grants.find(
    (item) =>
      item &&
      rules.canon(item.path) === key &&
      rules.modeOf(item.mode) === resolved &&
      String(item.sessionId ?? '') === owner,
  )
  if (existing) {
    existing.grantedAt = Date.now()
    /* ★ 必须重算：不然被重新批准的旧授权还是旧的过期时刻（C-1 探针踩到） */
    existing.expiresAt = expiresAt
    existing.mode = resolved
    if (reason) existing.reason = reason
  } else {
    data.grants.push({
      path: absolute,
      mode: resolved,
      sessionId: owner,
      reason,
      grantedAt: Date.now(),
      expiresAt,
    })
  }

  if (data.grants.length > MAX_GRANTS) data.grants = data.grants.slice(-MAX_GRANTS)
  persist()
  return { ok: true, path: absolute, mode: resolved }
}

/**
 * 用掉一条 once 授权 —— 只删**这一条**（路径 + 会话都对上）。
 *
 * @param {{ path: string, mode: string, sessionId?: string }} grant
 */
function consume(grant) {
  if (!grant || grant.mode !== 'once') return
  const data = all()
  const target = rules.canon(grant.path)
  const owner = String(grant.sessionId ?? '')
  data.grants = data.grants.filter(
    (item) =>
      !(
        item &&
        rules.canon(item.path) === target &&
        String(item.sessionId ?? '') === owner &&
        item.mode === 'once'
      ),
  )
  persist()
}

/** 撤掉某个路径的全部授权（界面上「撤销」按钮） */
function revoke(target) {
  const data = all()
  const key = rules.canon(rules.realpath(target))
  const before = data.grants.length
  data.grants = data.grants.filter((item) => rules.canon(item.path) !== key)
  persist()
  return { ok: true, removed: before - data.grants.length }
}

function revokeAll() {
  cache = { version: 1, grants: [] }
  persist()
  return { ok: true }
}

/** 列出来给界面看（顺手清掉过期的会话类授权） */
function list() {
  const now = Date.now()
  const data = all()
  const alive = data.grants.filter((item) => {
    const mode = rules.modeOf(item?.mode)
    if (mode === 'permanent') return true
    const expiresAt = Number(item?.expiresAt ?? 0)
    return !(expiresAt > 0 && expiresAt < now)
  })
  if (alive.length !== data.grants.length) {
    data.grants = alive
    persist()
  }
  return alive.map((item) => ({
    path: item.path,
    mode: rules.modeOf(item.mode),
    reason: item.reason ?? '',
    grantedAt: item.grantedAt,
    expiresAt: item.expiresAt ?? 0,
  }))
}

module.exports = {
  SESSION_TTL_MS,
  all,
  add,
  consume,
  revoke,
  revokeAll,
  list,
}
