/**
 * 浏览器扩展的**站点黑名单**（用户拉黑的站点 → 读不了、也点不动）
 *
 * ── 为什么是「黑名单」而不是「白名单」────────────────────────────
 *
 * 用户 2026-10-20 拍板：**默认全部允许，用户可拉黑**。理由是零摩擦（装好即用）。
 * 代价如实写在这里：默认状态下「未授权站点不能读取」这条验收**不成立** ——
 * 它只在用户拉黑某个站点之后才成立。所以验收脚本验的是「拉黑之后拦得住」，
 * 不是「默认识别得出未授权」。
 *
 * ── 为什么策略在主进程而不是扩展里 ──────────────────────────────
 *
 * 用户拍板「策略与审计都在主进程、和 risk/net-policy 同族」。这样：
 *   · 工具侧（`edge_*`）与扩展侧（按钮）用的是**同一份**判定；
 *   · 谁在什么时候问过、结论是什么，主进程能记进日志。
 * 代价：每次读/操作多一次往返（实测 3~8ms）。
 *
 * ── 唯一真相源 ─────────────────────────────────────────────────
 *
 * 落盘形状、host 归一化、父域匹配规则**只有这一处**。扩展侧不缓存判定结果
 * （缓存会让「刚拉黑」在下一次请求前仍然有效 —— 那正是这个功能最不该出错的地方）。
 *
 * 数据落在 `data/ext-sites.json`（硬约束 #3：只落 data/），走内核唯一的文本原子写。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const { writeAtomic } = require('./safe-write.cjs')
const log = require('./log.cjs')

/** 落盘格式版本（将来改形状靠它分流） */
const VERSION = 2

/** 文件名（不进 config.json —— 那是配置，这是安全策略，分开存） */
function file() {
  return path.join(DIRS.data, 'ext-sites.json')
}

/**
 * 把 url 或裸 host 归一成 host（小写、去端口、去路径）。
 *
 * ★ 归一化必须与「匹配」用同一套口径：拉黑时存 `Example.COM`、检查时给
 *   `https://example.com/a` —— 不归一就永远匹配不上，而**不会报任何错**。
 *
 * @param {string} input
 * @returns {string} 归一后的 host；给不出就空串
 */
function hostOf(input) {
  const text = String(input ?? '').trim()
  if (!text) return ''
  try {
    /* 带协议的走 URL 解析（`u.hostname` 已经是小写、无端口） */
    const u = new URL(text)
    return String(u.hostname || '').toLowerCase()
  } catch {
    /* 裸 host / host:port / host/path —— 手工切 */
    return text.toLowerCase().split('/')[0].split(':')[0]
  }
}

/**
 * 读盘。
 *
 * ★ 两种「读不到」必须分开（2026-10-20 用户指出的第一处洞）：
 *   · **文件不在**（ENOENT）= 用户从没配过 → 可核实为空表（默认放行是对的）
 *   · **读不了 / 解析不了** = 无法核实 → `verified:false`，check() 会**拒绝**
 *   以前两者都返回空表，于是「策略文件坏了」被当成「用户没拉黑过任何站点」——
 *   已拉黑的网站就这样重新变可读了，而且**没有任何提示**。
 */
function read() {
  let raw
  try {
    raw = fs.readFileSync(file(), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { version: VERSION, sites: {}, verified: true, error: '' }
    return { version: VERSION, sites: {}, verified: false, error: `读不到站点策略文件（${describe(error)}）` }
  }
  try {
    const obj = JSON.parse(raw)
    if (!obj || ![1, VERSION].includes(Number(obj.version))) throw new Error('不支持的站点策略版本')
    const sites = obj.sites && typeof obj.sites === 'object' && !Array.isArray(obj.sites) ? obj.sites : {}
    return { version: Number(obj.version), sites, verified: true, error: '' }
  } catch (error) {
    return { version: VERSION, sites: {}, verified: false, error: `站点策略文件坏了，解析不了（${describe(error)}）` }
  }
}

/** 把任意错误压成一句人话（read / check 的 error 文案都用它，别各写一份） */
function describe(error) {
  return error instanceof Error ? error.message : String(error ?? '未知错误')
}

/** 写盘。失败**不抛**（返回 `{ok:false,error}`，由 setSite 转成人话给界面） */
function write(state) {
  try {
    fs.mkdirSync(DIRS.data, { recursive: true })
    if (state.version === 1 && fs.existsSync(file())) {
      const backup = path.join(DIRS.data, 'ext-sites.v1.backup.json')
      if (!fs.existsSync(backup)) writeAtomic(backup, fs.readFileSync(file(), 'utf8'))
    }
    writeAtomic(file(), JSON.stringify({ version: VERSION, sites: state.sites }, null, 2))
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`写站点策略失败：${message}`)
    return { ok: false, error: message }
  }
}

/**
 * 命中判定：host 本身被拉黑，或**它的某个父域**被拉黑。
 *
 * `a.example.com` 会命中 `example.com`（拉黑整个域是用户的真实意图）；
 * 父域匹配**只从两段起算** —— 否则拉黑一条 `localhost` 会把 `com` 也当成父域。
 *
 * @param {Record<string, { blocked?: boolean }>} sites
 * @param {string} host
 * @returns {{ host: string, entry: object } | null}
 */
function matchBlocked(sites, host, now = Date.now()) {
  if (!host) return null
  const exact = sites[host]
  const active = (entry) => entry && entry.blocked === true && (!Number(entry.expiresAt) || Number(entry.expiresAt) > now)
  if (active(exact)) return { host, entry: exact }
  const labels = host.split('.')
  for (let i = 1; i <= labels.length - 2; i += 1) {
    const parent = labels.slice(i).join('.')
    const entry = sites[parent]
    if (active(entry)) return { host: parent, entry }
  }
  return null
}

/**
 * 这个 url 能不能读 / 操作。
 *
 * @param {string} url
 * @returns {{ allowed: boolean, host: string, blockedBy: string, reason: string,
 *   verified: boolean, error: string }}
 *   `allowed:false` 有两种原因，**必须靠 `verified` 区分**：
 *     · `verified:true`  → 命中黑名单（`blockedBy` 是命中的 host，可能是父域）
 *     · `verified:false` → **核实不了策略**（文件坏了 / 读不了）→ `error` 说明原因
 *   人话文案由调用方按这些字段渲染 —— 这里不拼展示文案（两侧口径会漂）。
 */
function check(url) {
  const host = hostOf(url)
  const state = read()
  /* ★ 无法核实 → 拒绝，不放行。理由见 read() 的文件头注释。 */
  if (state.verified !== true) {
    return { allowed: false, host, blockedBy: '', reason: '', verified: false, error: state.error }
  }
  const hit = matchBlocked(state.sites, host)
  if (!hit) return { allowed: true, host, blockedBy: '', reason: '', verified: true, error: '' }
  return {
    allowed: false,
    host,
    blockedBy: hit.host,
    reason: String(hit.entry?.reason ?? ''),
    verified: true,
    error: '',
  }
}

/** 全部条目（设置抽屉用），按 host 排序。`verified:false` 时界面要能说清「读不到」 */
function list() {
  const state = read()
  const rows = Object.keys(state.sites)
    .sort()
    .map((host) => ({
      host,
      blocked: state.sites[host]?.blocked === true,
      expiresAt: Number(state.sites[host]?.expiresAt ?? 0),
      active: state.sites[host]?.blocked === true && (!Number(state.sites[host]?.expiresAt) || Number(state.sites[host].expiresAt) > Date.now()),
      reason: String(state.sites[host]?.reason ?? ''),
      at: Number(state.sites[host]?.at ?? 0),
    }))
  return { sites: rows, verified: state.verified === true, error: state.error }
}

/**
 * 拉黑 / 放行一个站点。
 *
 * @param {string} input url 或裸 host
 * @param {boolean} blocked true = 拉黑（拒绝），false = 放行
 * @param {string} [reason] 显示给用户的原因（可空）
 * @returns {{ ok: boolean, host?: string, blocked?: boolean, error?: string }}
 */
function setSite(input, blocked, reason, options = {}) {
  const host = hostOf(input)
  if (!host) return { ok: false, error: '给不出站点地址（空的或不是合法 host）' }
  const state = read()
  /*
   * ★ 读不出原文件时**不许写**（2026-10-20）：`read()` 这时给的是空表，照写就等于
   *   拿「什么站点都没拉黑」覆盖掉用户原来的配置 —— 那是**丢用户数据**，
   *   比读不到更严重。要重置就让用户自己删文件（明确动作，看得见后果）。
   */
  if (state.verified !== true) {
    return { ok: false, error: `${state.error} —— 先修好它再改；要丢弃旧配置就手动删掉 ${file()}` }
  }
  if (blocked === true) {
    const minutes = Number(options.minutes ?? 0)
    if (options.minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) return { ok: false, error: '临时拒绝期限必须在 1 分钟到 24 小时之间' }
    state.sites[host] = { blocked: true, reason: String(reason ?? ''), at: Date.now(), ...(minutes ? { expiresAt: Date.now() + minutes * 60000 } : {}) }
  } else {
    /* 放行 = 删掉这条（不留 `blocked:false` 的死条目 —— 那种条目会让「列表」看着像有配置 */
    delete state.sites[host]
  }
  const written = write(state)
  if (!written.ok) return { ok: false, error: written.error }
  log.info(`站点策略：${host} → ${blocked === true ? '拉黑' : '放行'}`)
  return { ok: true, host, blocked: blocked === true }
}

/** 删掉一条（与 setSite(host,false) 等价，留给设置抽屉的「删」按钮） */
function removeSite(input) {
  return setSite(input, false)
}

/** 扩展只发动作和参数，所有策略操作仍在主进程同一处执行。 */
function handleRequest(payload) {
  const action = String(payload?.action ?? 'check')
  const url = String(payload?.url ?? '')
  if (action === 'list') return list()
  if (action === 'block-temporary') return setSite(url, true, '用户从 Edge 侧边栏临时拒绝', { minutes: Number(payload?.minutes) })
  if (action === 'unblock') return removeSite(url)
  if (action === 'check') return check(url)
  return { ok: false, error: '不认识的站点权限操作' }
}

module.exports = { VERSION, file, hostOf, check, list, setSite, removeSite, matchBlocked, handleRequest }
