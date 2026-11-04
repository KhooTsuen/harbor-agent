/**
 * 文件访问的**纯判断**：敏感清单 + 路径比较 + 授权记录是否还站得住
 *
 * 为什么从 `capability.cjs` 拆出来（2026-11-04，C-1）：
 *
 *   ① `capability.cjs` 已经 290 行、贴着 300 红线（AGENT.md 硬约束 2）；
 *   ② 更要紧的是**职责**：这里全是「什么算敏感」「这两条路径是同一个吗」
 *      「这条授权记录还能不能用」这类纯函数，而 capability.cjs 管的是
 *      「授权怎么存、什么时候过期、被谁消费」。
 *      C-1 的病因之一就是这两件事被写进了同一个 if：
 *      **「找到了一条授权」和「这条授权够不够格覆盖这个敏感路径」原来是一句话** ——
 *      于是 `sensitive` 一命中就把整条 `if (grant && !sensitive)` 否掉，
 *      「用户明确批准过的敏感文件」永远走不到放行那一支（读不到内容）。
 *
 * ★ 这里不读写磁盘上的授权文件，也不做任何决定 —— 只回答「够不够格」。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 授权模式。认不出来的值一律按最严的那一档处理（见 `modeOf`） */
const MODES = ['once', 'session', 'permanent']

/**
 * 认不出来的模式 → 按 `once` 处理。
 *
 * 为什么不按 `session`：`once` 用完即销，是三种里最短命、最少放权的那一档。
 * 历史数据里出现过 `mode: 'forever'` 这类脏值（C-1 探针实测），
 * 旧代码把它当「无过期、跨会话」用 —— 那等于一个拼错的字符串换来了永久全权。
 */
const STRICTEST_MODE = 'once'

/**
 * 敏感路径 —— 即便在允许范围内也要单独批准。
 *
 * 刻意保持简短：宁可多问一次，也不要放一个过期的浏览器 Profile 进来。
 * 每一条都写清「为什么敏感」，确认框会把它显示给用户。
 */
/** @type {Array<[RegExp, string]>} */
const SENSITIVE = [
  [/[\\/]\.ssh[\\/]|[\\/]\.ssh$/i, 'SSH 目录（里面是私钥）'],
  [/[\\/]id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, 'SSH 私钥'],
  [/[\\/]\.aws[\\/](credentials|config)$/i, 'AWS 凭据'],
  [/[\\/]\.(git-credentials|netrc|npmrc|pypirc)$/i, '凭据文件'],
  [/[\\/]\.env(\.[\w.-]+)?$/i, '环境变量文件（通常含密钥）'],
  [/[\\/](Cookies|Login Data|Local State|Web Data)$/i, '浏览器登录数据'],
  [/[\\/](Chrome|Edge|Chromium)[\\/]User Data[\\/]/i, '浏览器配置目录'],
  [/[\\/]Mozilla[\\/]Firefox[\\/]Profiles[\\/]/i, '浏览器配置目录'],
  [/[\\/]\.docker[\\/]config\.json$/i, 'Docker 凭据'],
  [/[\\/]\.kube[\\/]config$/i, 'Kubernetes 凭据'],
  [/[\\/]AppData[\\/]Roaming[\\/]Microsoft[\\/](Credentials|Crypto)[\\/]/i, 'Windows 凭据存储'],
]

/** Windows 不区分大小写；比较时统一成小写并去掉尾部分隔符 */
function canon(p) {
  const normalized = path.normalize(String(p ?? ''))
  const trimmed = normalized.length > 3 ? normalized.replace(/[\\/]+$/, '') : normalized
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/**
 * 拿到「真实的」绝对路径。
 *
 * 为什么不能只用 path.resolve：**软链接和 Windows 目录联接能绕过前缀比较**。
 * 工作目录下建一个 `link -> C:\Users\me\.ssh`，纯字符串比较会认为它在工作目录里。
 *
 * 目标可能还不存在（新建文件），所以从它往上找第一个存在的祖先，
 * 把祖先 realpath 之后再拼回剩余部分。
 */
function realpath(input) {
  const abs = path.resolve(String(input ?? ''))
  const parts = []
  let current = abs

  for (let i = 0; i < 40; i += 1) {
    try {
      const real = fs.realpathSync.native
        ? fs.realpathSync.native(current)
        : fs.realpathSync(current)
      return parts.length > 0 ? path.join(real, ...parts.reverse()) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return abs
      parts.push(path.basename(current))
      current = parent
    }
  }
  return abs
}

/** child 在 parent 里面（含相等）吗 */
function isInside(child, parent) {
  const c = canon(child)
  const p = canon(parent)
  if (!p) return false
  if (c === p) return true
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

/** 两个路径是不是**同一个**（只差大小写 / 尾分隔符不算不同） */
function pathsEqual(a, b) {
  const x = canon(a)
  const y = canon(b)
  return Boolean(x) && x === y
}

/** 命中敏感规则吗 */
function sensitiveReason(target) {
  const text = String(target ?? '')
  for (const [pattern, reason] of SENSITIVE) if (pattern.test(text)) return reason
  return ''
}

/** 模式归一：认不出来 → 最严的 `once` */
function modeOf(value) {
  const mode = String(value ?? '')
  return MODES.includes(mode) ? mode : STRICTEST_MODE
}

/**
 * 会话归属：这条授权是这个会话的吗。
 *
 * ★ 旧代码是「任一方为空就跳过检查」（`grant.sessionId !== sessionId && sessionId && grant.sessionId`），
 *   于是**调用方没有会话身份时，别人的会话授权全都可以用** —— C-1 探针实测
 *   `ok: true`。现在改成严格相等：身份对不上就是别人的。
 *
 * @param {{ sessionId?: string }} grant
 * @param {string} sessionId 调用方的会话身份
 */
function ownedBy(grant, sessionId) {
  return String(grant?.sessionId ?? '') === String(sessionId ?? '')
}

/**
 * 这条授权记录「还站得住」吗；站不住就返回原因（用来记日志，不还给模型）。
 *
 * ★ 保守处理的落点。历史数据里真实出现过这些形状（C-1 探针逐条实测过）：
 *
 *   - 没有 `mode` 字段  → 旧代码当「无过期、跨会话」用，等于一个缺字段换永久全权
 *   - `mode: 'forever'` → 同上（认不出来的值）
 *   - `expiresAt: 0`    → 对 session 来说等于永不过期，忘了清就一直有效
 *
 * 现在：模式归一 → 会话类授权必须带自己的会话身份 → 会话类必须有过期时刻且在将来。
 * 认不出的、缺字段的、已经说不清归属的，一律**不算授权**（而不是算最宽的那种）。
 *
 * @param {Record<string, any> | null | undefined} grant
 * @returns {{ ok: boolean, mode: string, problem: string }}
 */
function inspectGrant(grant) {
  if (!grant || typeof grant !== 'object') return { ok: false, mode: '', problem: '记录不是对象' }
  const target = grant.path
  if (typeof target !== 'string' || !target.trim()) {
    return { ok: false, mode: '', problem: '缺 path' }
  }

  const mode = modeOf(grant.mode)
  /* 模式字段本身无效时也拦下来 —— 不能「归一成 once 之后照样用」，
     那会把一条脏记录变成一次可用授权（正确方向是让它失效、逼用户重新批） */
  if (String(grant.mode ?? '') !== mode) {
    return { ok: false, mode, problem: `模式无效（${String(grant.mode ?? '缺失')}）` }
  }

  const expiresAt = Number(grant.expiresAt ?? 0)
  if (!Number.isFinite(expiresAt)) return { ok: false, mode, problem: '过期时刻不是数字' }

  if (mode === 'permanent') {
    /* 永久授权不看会话也不看过期（用户明确选的，界面上能单独撤销） */
    return { ok: true, mode, problem: '' }
  }

  /* once / session 都要能说清「是谁批的」—— 否则没法做会话隔离 */
  if (!String(grant.sessionId ?? '')) {
    return { ok: false, mode, problem: '缺少会话身份' }
  }
  /*
   * ★ `expiresAt: 0` 对 once / session 一律算「说不清何时失效」→ 失效。
   *   旧代码写过 `expiresAt: 0` 的 once 记录（那时 once 没有窗口），
   *   这类老记录会因此不再放权 —— **有意的保守方向**，逼用户重新批一次，
   *   而不是让一条来历和期限都说不清的授权无限期有效。
   */
  if (expiresAt <= 0) return { ok: false, mode, problem: '会话类授权没有过期时刻' }
  if (expiresAt < Date.now()) return { ok: false, mode, problem: '已过期' }

  return { ok: true, mode, problem: '' }
}

module.exports = {
  MODES,
  STRICTEST_MODE,
  SENSITIVE,
  canon,
  realpath,
  isInside,
  pathsEqual,
  sensitiveReason,
  modeOf,
  ownedBy,
  inspectGrant,
}
