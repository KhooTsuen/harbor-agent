/**
 * 文件访问能力（Capability）
 *
 * 之前 `resolvePath` 的规则是「相对路径按工作目录，绝对路径原样放行」。
 * 好用，但等于**没有任何边界** —— 模型可以从工作目录走到 C:\、
 * 用户目录、.ssh、浏览器 Profile、云盘，全都畅通。
 *
 * 现在的规则：
 *
 *   workspace（默认）  只在工作目录里自由读写，出去要授权
 *   granted            工作目录 + 用户批准过的路径
 *   full               不设限（用户在设置里明确选的）
 *
 * 另外有一层**敏感路径**：即便在工作目录里，`.ssh`、`id_rsa`、`.env`、
 * 浏览器 Profile、`.git-credentials` 这类东西也要单独批准。
 * 项目里放个 `.env` 很常见，所以不能一律拒绝 —— 但要让人知道自己在批什么。
 *
 * 授权记录写在 data/capabilities.json，可以是一次性 / 本会话 / 永久。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 授权模式 */
const MODES = ['once', 'session', 'permanent']

/**
 * 敏感路径 —— 即便在允许范围内也要单独批准。
 *
 * 刻意保持简短：宁可多问一次，也不要放一个过期的浏览器 Profile 进来。
 * 每一条都写清「为什么敏感」，确认框会把它显示给用户。
 */
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

let cache = null

function filePath() {
  return path.join(require('./paths.cjs').DIRS.data, 'capabilities.json')
}

function load() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'))
    cache = {
      version: 1,
      grants: Array.isArray(parsed.grants)
        ? parsed.grants.filter((g) => g && typeof g.path === 'string')
        : [],
    }
  } catch {
    cache = { version: 1, grants: [] }
  }
  return cache
}

function persist() {
  const data = load()
  fs.mkdirSync(path.dirname(filePath()), { recursive: true })
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2), 'utf8')
}

/* ── 路径比较 ─────────────────────────────────────────────── */

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

/** 命中敏感规则吗 */
function sensitiveReason(target) {
  const text = String(target ?? '')
  for (const [pattern, reason] of SENSITIVE) if (pattern.test(text)) return reason
  return ''
}

/* ── 对外 ─────────────────────────────────────────────────── */

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
 * @returns {{ ok: boolean, path: string, absolute: string, reason?: string, needGrant?: boolean, sensitive?: string }}
 */
function check(target, { workdir, sessionId } = {}) {
  const absolute = realpath(target)
  const scope = currentScope()

  if (scope === 'full') return { ok: true, path: target, absolute }

  const sensitive = sensitiveReason(absolute)
  const insideWorkspace = workdir ? isInside(absolute, realpath(workdir)) : false

  if (insideWorkspace && !sensitive) return { ok: true, path: target, absolute }

  /* 工作目录之外，或者命中敏感规则 —— 看有没有有效授权 */
  const grant = findGrant(absolute, sessionId)
  if (grant && !sensitive) {
    if (grant.mode === 'once') consumeGrant(grant.path)
    return { ok: true, path: target, absolute, granted: grant.mode }
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

/** 找一条覆盖该路径的有效授权 */
function findGrant(absolute, sessionId) {
  const data = load()
  const now = Date.now()
  const target = canon(absolute)

  return (
    data.grants.find((grant) => {
      if (grant.expiresAt && grant.expiresAt < now) return false
      if (
        grant.mode === 'session' &&
        sessionId &&
        grant.sessionId &&
        grant.sessionId !== sessionId
      ) {
        return false
      }
      const granted = canon(grant.path)
      return (
        target === granted ||
        target.startsWith(granted.endsWith(path.sep) ? granted : granted + path.sep)
      )
    }) ?? null
  )
}

/** 授权。mode: once / session / permanent */
function grant(target, { mode = 'session', sessionId = '', reason = '' } = {}) {
  const data = load()
  const absolute = realpath(target)
  const key = canon(absolute)

  const existing = data.grants.find((g) => canon(g.path) === key && g.mode === mode)
  if (existing) {
    existing.grantedAt = Date.now()
    if (reason) existing.reason = reason
  } else {
    data.grants.push({
      path: absolute,
      mode: MODES.includes(mode) ? mode : 'session',
      sessionId,
      reason,
      grantedAt: Date.now(),
      /** 永久授权不设过期；会话级 12 小时后失效（防止忘了清） */
      expiresAt: mode === 'session' ? Date.now() + 12 * 60 * 60 * 1000 : 0,
    })
  }

  /* 只留最近 200 条，别让这个文件无限长 */
  if (data.grants.length > 200) data.grants = data.grants.slice(-200)
  persist()
  return { ok: true, path: absolute, mode }
}

function consumeGrant(grantPath) {
  const data = load()
  data.grants = data.grants.filter((g) => canon(g.path) !== canon(grantPath) || g.mode !== 'once')
  persist()
}

function revoke(target) {
  const data = load()
  const key = canon(realpath(target))
  const before = data.grants.length
  data.grants = data.grants.filter((g) => canon(g.path) !== key)
  persist()
  return { ok: true, removed: before - data.grants.length }
}

function revokeAll() {
  cache = { version: 1, grants: [] }
  persist()
  return { ok: true }
}

/** 列出来给界面看（顺带把过期的标出来） */
function list() {
  const now = Date.now()
  const data = load()
  /* 顺手清掉过期的一次性/会话授权 */
  const alive = data.grants.filter((g) => !(g.expiresAt && g.expiresAt < now))
  if (alive.length !== data.grants.length) {
    data.grants = alive
    persist()
  }
  return alive.map((g) => ({
    path: g.path,
    mode: g.mode,
    reason: g.reason ?? '',
    grantedAt: g.grantedAt,
    expiresAt: g.expiresAt ?? 0,
  }))
}

module.exports = {
  MODES,
  check,
  grant,
  revoke,
  revokeAll,
  list,
  isInside,
  realpath,
  sensitiveReason,
  SENSITIVE,
}
