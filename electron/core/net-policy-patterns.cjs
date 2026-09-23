/**
 * 网络策略的**模式表与主机抠取**（纯数据 + 正则，不联网、不做 DNS）
 *
 * 从 `net-policy.cjs` 拆出来的：那边两件事挤一起 369 行，**顶破 300 行红线**。
 * 拆法按职责切：这里只回答「这段文本里有没有联网语义、涉及哪几个主机」；
 * 「该不该放行」在 `net-policy.cjs`（策略/裁决/人话）。
 *
 * 模式表**不复制第二份**：`risk-patterns.cjs` 的 `NETWORK` 作为「基础」条目引进来，
 * 只补它没覆盖的（bitsadmin / nc / telnet / ftp / gh / docker pull / aria2c / npx /
 * pnpm|yarn 安装 / SMB）。它是单条正则、没有标签，混不进带标签的表里 —— 所以是一条
 * 基础条目，`from` 字段标了出处。
 */

const { NETWORK: BASIC_NETWORK } = require('./risk-patterns.cjs')

/* ── 模式表 ──────────────────────────────────────────────── */

/** 每条 `{ id, label, from?, pattern }`；label 会进「为什么拦」的理由里 */
const NET_RISK = [
  { id: 'basic', from: 'risk-patterns.NETWORK', label: '联网命令', pattern: BASIC_NETWORK },
  { id: 'bits', label: 'BITS 传输', pattern: /\b(Start-BitsTransfer|bitsadmin)\b/i },
  { id: 'certutil', label: 'certutil 下载', pattern: /\bcertutil\b[^\n]*-urlcache/i },
  { id: 'netcat', label: 'netcat 直连', pattern: /(?:^|[\s"'|&;(])(nc|ncat)\s/i },
  { id: 'telnet', label: 'telnet 直连', pattern: /(?:^|[\s"'|&;(])telnet\s/i },
  { id: 'ftp', label: 'ftp 传输', pattern: /(?:^|[\s"'|&;(])(ftp|lftp)\s|\bftps?:\/\//i },
  { id: 'gh', label: 'GitHub CLI', pattern: /(?:^|[\s"'|&;(])gh\s/i },
  { id: 'docker', label: '拉取或推送镜像', pattern: /\bdocker(-compose)?\s+(pull|push)\b/i },
  { id: 'aria2', label: 'aria2 下载', pattern: /(?:^|[\s"'|&;(])aria2c\b/i },
  {
    id: 'gitRemote',
    label: 'git 远程操作',
    pattern: /\bgit\s+(ls-remote|remote\s+update|submodule\s+update)\b/i,
  },
  {
    id: 'pkg',
    label: '从网上装包',
    pattern: /\b(npm|pnpm|yarn)\s+(i|ci|add|install|create|dlx)\b|\bnpx\b/i,
  },
  { id: 'smb', label: '网络共享', pattern: /\bnet\s+(use|view)\b/i },
]

/** 「从网上**取**数据」那一类（只影响理由措辞：取数据 vs 发数据） */
const FETCH =
  /\b(curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod|irm|aria2c|Start-BitsTransfer)\b/i

/** http 类传输（MCP 用）：这种配置天然要联网 */
const HTTP_TRANSPORT_RE = /^(http|https|sse|streamable[-_]http|ws|wss|websocket)$/

/* ── 主机名：只用正则抠，不发请求 ─────────────────────────── */

const URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#"'`<>()\\]+)/gi
const USER_HOST_RE = /\b[a-z0-9._-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi
const HOST_PORT_RE = /(?:^|[\s"'=(])([a-z0-9-]+(?:\.[a-z0-9-]+)+):\d{1,5}\b/gi
const IPV4_RE = /\b(\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?\b/g
const UNC_RE = /(?:^|[\s"'(=])\\\\([A-Za-z0-9._-]+)[\\/]/
/** `example.com/x` 这种没写 scheme 的 —— **只在命中了联网模式表时才认** */
const BARE_PATH_RE = /(?:^|[\s"'=(])(?:\.\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/[^\s"'`]*/gi
/** 本地协议：`file://` 就是读盘，不算联网 */
const LOCAL_SCHEME_RE =
  /^(file|data|about|blob|javascript|chrome|chrome-extension|devtools|vscode|vscode-webview)$/

/**
 * 主机名归一化：去 userinfo / 端口 / 方括号 / 结尾的点，转小写。
 * 长得不像主机名就返回空串（**绝不猜**）。
 */
function cleanHost(raw) {
  let host = String(raw ?? '').trim().toLowerCase()
  const at = host.lastIndexOf('@')
  if (at >= 0) host = host.slice(at + 1)
  if (/^\[[^\]]+\](?::\d+)?$/.test(host)) host = host.slice(1, host.indexOf(']'))
  else host = host.replace(/:\d+$/, '')
  host = host.replace(/\.+$/, '')
  if (!host || /\s/.test(host) || /[^a-z0-9._:-]/.test(host)) return ''
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ip && ip.slice(1).some((n) => Number(n) > 255)) return ''
  return host
}

/**
 * 从命令 / URL 里抠主机名。**只抠形状明确的**：URL 的 authority、`user@host`、
 * `host:端口`、IPv4、UNC（`\\server\share`）；`barePaths` 打开时再认 `host.tld/…`。
 * 抠不出来就返回空数组 —— 不猜。
 */
function extractHosts(text, options = {}) {
  const source = String(text ?? '')
  const out = []
  const push = (value) => {
    const host = cleanHost(value)
    if (host && !out.includes(host)) out.push(host)
  }

  for (const m of source.matchAll(URL_RE)) {
    if (LOCAL_SCHEME_RE.test(m[1].toLowerCase())) continue
    push(m[2])
  }
  for (const m of source.matchAll(USER_HOST_RE)) push(m[1])
  for (const m of source.matchAll(HOST_PORT_RE)) push(m[1])
  for (const m of source.matchAll(IPV4_RE)) push(m[1])
  const unc = UNC_RE.exec(source)
  if (unc) push(unc[1])
  if (options.barePaths) for (const m of source.matchAll(BARE_PATH_RE)) push(m[1])

  return out.slice(0, 20)
}

/* ── 主机名单：deny 优先于 allow ─────────────────────────── */

/** `*.example.com` 的说法；`*` 也匹配裸域（少写一个点绕不过去） */
function matchPattern(pattern, host) {
  const text = String(pattern ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split('/')[0]
  if (!text) return false
  const wildcard = text.startsWith('*.')
  const base = cleanHost(wildcard ? text.slice(2) : text)
  if (!base) return false
  return wildcard ? host === base || host.endsWith(`.${base}`) : host === base
}

/**
 * 某个主机在名单里算什么：`'allow' | 'deny' | 'default'`。
 * **deny 优先于 allow** —— 两张表都写就是拦（自检钉着）。
 */
function hostVerdict(host, policy) {
  const target = cleanHost(host)
  if (!target) return 'default'
  const list = (key) => (Array.isArray(policy?.[key]) ? policy[key] : [])
  if (list('denyHosts').some((p) => matchPattern(p, target))) return 'deny'
  if (list('allowHosts').some((p) => matchPattern(p, target))) return 'allow'
  return 'default'
}

/* ── 这次动作涉不涉及网络 ────────────────────────────────── */

/** MCP 服务器的启动命令拼成一行（用来判断它本身是不是联网命令） */
function commandlineOf(server) {
  const s = server ?? {}
  const args = Array.isArray(s.args) ? s.args.map(String) : []
  return [s.command ?? '', ...args].join(' ').trim()
}

/** MCP 服务器要不要联网：有 url / http 类传输 / 命令行本身就是联网命令（`npx` 会去下载） */
function mcpNeedsNetwork(server) {
  const s = server ?? {}
  if (typeof s.url === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(s.url)) return true
  const transport = String(s.transport ?? s.type ?? '').toLowerCase()
  if (HTTP_TRANSPORT_RE.test(transport)) return true
  return detect(commandlineOf(s)).network
}

/**
 * 命令文本里有联网语义吗。
 *
 * @returns {{ network: boolean, hosts: string[], fetches: boolean, reasons: string[] }}
 *   · `network` **只看模式表**（`dir \\srv\share` 这种只靠 UNC 的访问不算联网命令，
 *     但 `hosts` 里会有 srv —— 它仍然会被主机禁止名单拦住）
 *   · `hosts` 只用正则抠：**不做 DNS 解析、不发任何请求**
 */
function detect(command) {
  const text = String(command ?? '')
  const reasons = []
  for (const entry of NET_RISK) if (entry.pattern.test(text)) reasons.push(entry.label)
  return {
    network: reasons.length > 0,
    hosts: extractHosts(text, { barePaths: reasons.length > 0 }),
    fetches: FETCH.test(text),
    reasons,
  }
}

module.exports = {
  NET_RISK,
  LOCAL_SCHEME_RE,
  cleanHost,
  commandlineOf,
  detect,
  extractHosts,
  hostVerdict,
  mcpNeedsNetwork,
}
