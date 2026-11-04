/**
 * 文件访问能力（Capability）—— 对外唯一出口
 *
 * 规则：`resolvePath` 原来是「相对路径按工作目录，绝对路径原样放行」，
 * 等于**没有任何边界** —— 模型能从工作目录走到 C:\、用户目录、.ssh、浏览器
 * Profile、云盘。现在的分档：
 *
 *   workspace（默认）  只在工作目录里自由读写，出去要授权
 *   granted            工作目录 + 用户批准过的路径
 *   full               不设限（用户在设置里明确选的）
 *
 * 另有**敏感路径**一层：即便在工作目录里，`.ssh`、`id_rsa`、`.env`、
 * 浏览器 Profile、`.git-credentials` 这类东西也要单独批准 ——
 * 项目里放个 `.env` 很常见，不能一律拒绝，但要让人知道自己在批什么。
 *
 * ── C-1（2026-11-04）：敏感文件「批了也读不到」，几个病一起治 ──
 *
 *   ① **批准后仍然读不到**（本轮的主诉）。旧 `check()` 里
 *      `if (grant && !sensitive)` —— 敏感一命中就连**用户刚批的那一条**一起否掉，
 *      于是 `permission.cjs` 批完授权、重试，还是同一个拒绝。探针实测：
 *      批准后返回「需要授权才能访问」、`capabilities.json` 里明明有那条授权。
 *      更糟的是 `scope === 'full'` 那一支在敏感判断**之前**返回 ok，
 *      工具层却先抛 PERMISSION_REQUIRED —— 两条判据各说各的。
 *
 *   ② **敏感文件继承父目录授权**：批了 `D:\project` 就等于批了它下面的 `.env`。
 *
 *   ③ **会话隔离漏了**：旧 `findGrant` 是「任一方 sessionId 为空就跳过检查」，
 *      调用方没身份时**别人的会话授权全都能用**。
 *
 *   ④ **once 被别的会话用掉 / 提前消耗**：既没有归属检查，删除又按路径删 ——
 *      别人的 once 会被一起抹掉。
 *
 *   ⑤ **无效记录拿到全权**：缺 `mode` 或 `mode: 'forever'` 被当成「无过期、跨会话」；
 *      重新批准过期授权不更新 `expiresAt`，刚批完就是过期的。
 *
 *   拆成三层（AGENT.md 硬约束 2：单文件 300 行；更要紧的是职责）：
 *     `capability-rules.cjs` 纯判断（敏感清单 / 路径比较 / 一条记录够不够格）
 *     `capability-store.cjs` 记录读写（怎么存、怎么加、怎么删、怎么列）
 *     **本文件**：对外的 `check / grant / revoke / list`，判据链在这里串起来
 */

const path = require('node:path')
const rules = require('./capability-rules.cjs')
const store = require('./capability-store.cjs')

/** 授权模式（真相源在 rules，这里转出去给界面/自检用） */
const MODES = rules.MODES

/** 敏感清单 —— 别在别处再写一份 */
const SENSITIVE = rules.SENSITIVE

/**
 * 「这次调用是谁」—— **全项目只有这一处**算会话身份。
 *
 * 为什么要有它（硬约束 9：跨模块约定只有一处真相源）：
 *   C-1 之前 `_shared.cjs` 写的是 `ctx.sessionId ?? ctx.threadId ?? ''`，
 *   而「批准之后落授权」的那一层只认 `ctx.sessionId`。两条判据各算一遍的后果很具体：
 *   某条链路只带 `threadId` 时，**检查**能用某条授权、**落授权**却拿到空身份
 *   → 会话类授权被拒 → 重试还是同一个拒绝，用户看到的就是 C-1 的主诉「批了也读不到」。
 *
 * 认得 `threadId` 是历史原因（早期 ctx 只带 threadId），不是新语义 —— 保持原样。
 *
 * @param {{ sessionId?: string, threadId?: string }} [ctx]
 * @returns {string}
 */
function sessionKey(ctx) {
  return String(ctx?.sessionId ?? ctx?.threadId ?? '')
}

function currentScope() {
  try {
    return require('./config.cjs').get().tools.fileScope
  } catch {
    return 'workspace'
  }
}

/**
 * 检查一个路径能不能动。
 *
 * `fileScope` 与授权说的是「这个路径允不允许」；**要不要弹窗问用户**是另一回事，
 * 那一层在 `tools/permission.cjs`（它手里有 `ctx.permission`）。
 *
 * @param {string} target
 * @param {{ workdir?: string, sessionId?: string, consumeOnce?: boolean, approvedPaths?: string[] }} [options]
 *   `approvedPaths` = **本次调用内**用户刚批准的精确路径（不落盘，见 `approvedNow`）
 * @returns {{ ok: boolean, path: string, absolute: string, reason?: string, needGrant?: boolean, sensitive?: string, granted?: string }}
 *   `granted` = 这次靠哪一档授权放行的（没有授权就是 `undefined`）
 */
function check(target, options = {}) {
  const { workdir, consumeOnce = true, approvedPaths } = options
  /* 「这次是谁」走同一个算法：传 sessionId 或 threadId 都认 */
  const sessionId = sessionKey(options)
  const absolute = rules.realpath(target)

  if (currentScope() === 'full') return { ok: true, path: target, absolute }

  const sensitive = rules.sensitiveReason(absolute)
  const insideWorkspace = workdir ? rules.isInside(absolute, rules.realpath(workdir)) : false

  if (insideWorkspace && !sensitive) return { ok: true, path: target, absolute }

  /*
   * 走到这儿：要么在工作目录之外，要么是敏感文件（也可能两者都是）。
   *
   * ★ 敏感的唯一区别是 `exactOnly`：**只认精确路径的授权**。
   *   用户批了 `D:\project` 不代表批了它下面那个 `.env` ——
   *   确认框上写的是前者，风险却是后者。
   */
  const grant = findGrant(absolute, sessionId, { exactOnly: Boolean(sensitive) })
  if (grant) {
    if (grant.mode === 'once' && consumeOnce !== false) store.consume(grant)
    return { ok: true, path: target, absolute, granted: grant.mode }
  }

  /*
   * ★ C-1（无会话身份的调用）：用户刚点的「允许」**只在这条路径上、只在本次调用内**生效。
   *
   * 为什么需要这一支：`tools/permission.cjs` 原本的做法是「没有身份就退成 once」，
   * 但 `capability-store.add` 对**所有**非 permanent 模式都要求 owner —— 于是 grant
   * 返回 `ok:false`，批准后重试仍是同一个拒绝。探针实测：ctx 里既无 sessionId 也无
   * threadId 时，用户批准后读不到任何内容、授权表里一条记录都没有。真实链路存在
   * （`codex-mcp-bridge.cjs` 的 makeCtx 就不带身份）。
   *
   * 为什么不能「落一条无 owner 的 once」：那样它会**被任何其它无身份调用复用**，
   * 等于把一次批准变成跨会话的通行证。所以这里只认内存里的、由
   * `permission.cjs` 在重试前后严格成对加删的一次性名单。
   *
   * 只做**精确相等**（和敏感路径同一条判据）：这只是「本次批准的那个文件」，
   * 不是「这个目录」。也不需要过 `inspectGrant` —— 它压根不是一条落盘授权。
   */
  if (approvedNow(absolute, approvedPaths)) {
    return { ok: true, path: target, absolute, granted: 'once' }
  }

  return {
    ok: false,
    path: target,
    absolute,
    needGrant: true,
    sensitive: sensitive || undefined,
    reason: sensitive
      ? `这是${sensitive}`
      : insideWorkspace
        ? '虽然是工作目录里的文件，但它是敏感文件'
        : `它在工作目录之外（${absolute}）`,
  }
}

/**
 * 本次调用内、用户刚批准的那个路径吗。
 *
 * ★ 只比**精确相等**：`D:\project` 的批准不等于 `D:\project\.env`。
 *   这一支存在的全部理由就是「没有会话身份 → 不能落盘 → 只在这次调用内认」，
 *   所以**不做父目录覆盖**（那属于落盘授权的语义，走 `findGrant`）。
 *
 * @param {string} target 已经 canon 过的绝对路径
 * @param {string[] | undefined} approvedPaths
 */
function approvedNow(target, approvedPaths) {
  if (!Array.isArray(approvedPaths) || approvedPaths.length === 0) return false
  const wanted = rules.canon(target)
  return approvedPaths.some(
    (item) => typeof item === 'string' && item && rules.canon(rules.realpath(item)) === wanted,
  )
}

/**
 * 找一条**够格**覆盖该路径的授权。
 *
 * ① 过期 / 无效记录不算（`rules.inspectGrant`：缺 mode、mode 拼错、
 *    会话类没有过期时刻 —— 一律不算「用户批过」）。
 * ② **会话隔离**：once / session 只对批它的那个会话有效。
 * ③ **once 只属于批它的会话**：别人用不掉，也不会被提前消费。
 * ④ `exactOnly`（敏感路径）只比精确相等，不做父目录覆盖。
 *
 * @param {string} absolute
 * @param {string} [sessionId]
 * @param {{ exactOnly?: boolean }} [options]
 * @returns {object | null}
 */
function findGrant(absolute, sessionId = '', options = {}) {
  const { exactOnly = false } = options
  const target = rules.canon(absolute)

  for (const grant of store.all().grants) {
    const state = rules.inspectGrant(grant)
    if (!state.ok) continue
    /* 会话类必须属于当前会话；permanent 是用户明确的全权 */
    if (state.mode !== 'permanent' && !rules.ownedBy(grant, sessionId)) continue

    const granted = rules.canon(grant.path)
    const hit = exactOnly
      ? target === granted
      : target === granted ||
        target.startsWith(granted.endsWith(path.sep) ? granted : granted + path.sep)
    if (hit) return grant
  }
  return null
}

/** 授权。mode: once / session / permanent（会话类必须带 sessionId） */
function grant(target, options) {
  return store.add(target, options)
}

function revoke(target) {
  return store.revoke(target)
}

function revokeAll() {
  return store.revokeAll()
}

/** 列出来给界面看 */
function list() {
  return store.list()
}

module.exports = {
  MODES,
  sessionKey,
  check,
  findGrant,
  grant,
  revoke,
  revokeAll,
  list,
  /* 下面几个是给别处用的工具函数 —— 实现都在 rules，别再抄一份 */
  isInside: rules.isInside,
  realpath: rules.realpath,
  sensitiveReason: rules.sensitiveReason,
  SENSITIVE,
}
