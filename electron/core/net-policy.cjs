/**
 * 网络策略（内核）：把「声明」变成「强制」
 *
 * 为什么有它 —— 2026-09-24 查出来的洞：`mcp.servers[].network`、技能里的
 * `permissions: network: deny` 都写在那儿，但**没有任何内核代码读过它们**
 * （`mcp-connection.cjs` 里 grep 不到 network）。用户以为关掉了，开关只是个装饰品。
 *
 * 这个文件提供两样东西：
 *   ① 全局策略（`security.network.mode` + 主机名单）的裁决 —— 已在 `run_shell` 和
 *      MCP 启动门上真正执行。
 *   ② `ctx.networkGrant` 的执行点（第 ① 条）—— **接口通了，但目前没有触发它的入口**：
 *      运行时技能只是一份清单，不存在「这次对话在用哪个技能」，详见
 *      `skill-permissions.cjs` 顶部的说明。别把它说成已经生效。
 *
 * ⚠️ **它不是防火墙，也不假装是。** `describePolicy()` 里那段「管不到什么」是交付内容
 * 的一部分（自检 73 组钉着它），别删、别改软。
 *
 * 模式表与主机抠取在 `net-policy-patterns.cjs`：两件事挤一起会顶破 300 行红线，
 * 所以按职责切开 —— 那里只回答「涉不涉及网络、涉及哪几个主机」，这里只回答「该不该放行」。
 *
 * 纯逻辑：不 require electron、不联网、**不做 DNS 解析**、不发任何请求。
 */

const {
  NET_RISK,
  LOCAL_SCHEME_RE,
  commandlineOf,
  detect,
  extractHosts,
  hostVerdict,
  mcpNeedsNetwork,
} = require('./net-policy-patterns.cjs')

/* ── 策略从哪来 ──────────────────────────────────────────── */

const MODE_LABEL = { allow: '允许', ask: '每次先问', deny: '禁止' }

/** 认不出来的模式一律当 `ask` —— **绝不因为写错就放行** */
function normalizeMode(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return text === 'allow' || text === 'deny' ? text : 'ask'
}

/**
 * 当前模式：`'allow' | 'ask' | 'deny'`。
 *
 * 读的是 **`config.json` 的 `security.network.mode`**（主代理要把它加进
 * `config-defaults.cjs` / `config-normalize.cjs`）；老配置里没这一段，容忍它不存在。
 *
 * @param {string|object} [injected] 注入（测试用）：直接给 `'deny'`，或 `{ mode }`
 */
function mode(injected) {
  if (typeof injected === 'string' && injected) return normalizeMode(injected)
  if (injected && typeof injected === 'object' && injected.mode !== undefined) {
    return normalizeMode(injected.mode)
  }
  try {
    return normalizeMode(require('./config.cjs').get()?.security?.network?.mode)
  } catch {
    /* ★ 读配置失败**不是**放行的理由：回落到 ask（自检钉着） */
    return 'ask'
  }
}

function stringsOf(source, key) {
  const raw = source?.[key]
  return Array.isArray(raw) ? raw.filter((v) => typeof v === 'string' && v.trim()) : []
}

/**
 * 当前生效的策略：注入 > 配置 > 空列表。
 * 注入渠道是 `ctx.netPolicy`（也接受平铺的 `ctx.mode / denyHosts / allowHosts`）。
 * 「注入的是空数组」= 没注入（回落配置）。
 */
function policyOf(injected) {
  let stored = {}
  try {
    stored = require('./config.cjs').get()?.security?.network ?? {}
  } catch {
    stored = {}
  }
  const own = injected?.netPolicy ?? injected ?? {}
  const pick = (key) => {
    const mine = stringsOf(own, key)
    return mine.length > 0 ? mine : stringsOf(stored, key)
  }
  return { mode: mode(own), denyHosts: pick('denyHosts'), allowHosts: pick('allowHosts') }
}

/** 按 kind 看这次动作的性质；`subject` 是理由里的主语 */
function inspect(kind, target) {
  if (kind === 'mcp') {
    const name = target?.name || target?.id || '未命名'
    const text = [target?.url, commandlineOf(target)].join(' ')
    return {
      network: mcpNeedsNetwork(target),
      hosts: extractHosts(text, { barePaths: true }),
      subject: `MCP 服务器「${name}」`,
    }
  }
  if (kind === 'webview') {
    const url = String(target ?? '')
    const scheme = (/^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1] ?? '').toLowerCase()
    return {
      network: Boolean(url) && !LOCAL_SCHEME_RE.test(scheme),
      hosts: extractHosts(url, { barePaths: true }),
      subject: `这个页面（${url.slice(0, 120)}）`,
    }
  }
  if (kind === 'skill') return { network: true, hosts: [], subject: '这个技能要求的联网动作' }
  const info = detect(target)
  return {
    network: info.network,
    hosts: info.hosts,
    subject: `这条命令（${info.reasons[0] ?? '带联网语义'}）`,
  }
}

/* ── 裁决 ────────────────────────────────────────────────── */

const allow = (reason) => ({ action: 'allow', reason })
const deny = (reason) => ({ action: 'deny', reason })

/**
 * 这次动作放不放行。
 *
 * ⚠️ 顺序**不能变**（自检逐条钉着）：
 *   ⓪ 不涉及网络、也没被主机禁止名单点名 → allow（网络策略不管本地命令）
 *   ① `ctx.networkGrant === 'deny'`（技能声明的强制档）→ deny
 *   ② `mode === 'deny'` → deny
 *   ③ 主机命中 denyHosts → deny（deny 优先于 allow）
 *   ④ 主机**全部**命中 allowHosts → allow
 *   ⑤ `mode === 'allow'` → allow
 *   ⑥ 其余 → ask
 *
 * @param {{ kind?: 'shell'|'mcp'|'webview'|'skill', target?: unknown, ctx?: object }} input
 * @returns {{ action: 'allow'|'ask'|'deny', reason: string }}
 */
function decide({ kind = 'shell', target, ctx = {} } = {}) {
  const policy = policyOf(ctx)
  const info = inspect(kind, target)
  const verdicts = info.hosts.map((host) => ({ host, verdict: hostVerdict(host, policy) }))
  const blocked = verdicts.find((v) => v.verdict === 'deny')
  const skill = ctx.skillName || ctx.skillId
  const who = skill ? `技能「${skill}」` : '当前技能'

  /* ⓪ 与网络无关（也没被主机名单点名）：网络策略不管 */
  if (!info.network && !blocked) return allow('这一步不涉及网络，网络策略不管它。')

  /* ① 技能声明优先于全局设置 —— 钉子，别调顺序 */
  if (ctx.networkGrant === 'deny') {
    return deny(
      `${who}声明了 network: deny。技能自己的边界比全局设置更严，所以这一步要联网的动作被拒绝。` +
        '要放行：改那个技能的 SKILL.md（permissions: - network: ask / allow），或停用这个技能。',
    )
  }

  /* ② 全局禁止 */
  if (policy.mode === 'deny') {
    return deny(
      '全局网络策略是「禁止」（config.json 的 security.network.mode），而' +
        `${info.subject}要联网。要放行：改成「每次先问」或「允许」，或把目标主机加进允许名单。`,
    )
  }

  /* ③ 主机禁止名单（deny 优先于 allow）*/
  if (blocked) {
    return deny(
      `主机 ${blocked.host} 在禁止名单里（security.network.denyHosts），而${info.subject}要连它。` +
        '禁止优先于允许 —— 它同时在允许名单里也拦。要放行：把它从禁止名单里删掉。',
    )
  }

  /* ④ 主机允许名单：**全部**主机都在名单里才算放行 */
  if (verdicts.length > 0 && verdicts.every((v) => v.verdict === 'allow')) {
    const list = verdicts.map((v) => v.host).join('、')
    return allow(`主机 ${list} 在允许名单里（security.network.allowHosts），放行。`)
  }

  /* ⑤ 全局允许 */
  if (policy.mode === 'allow') {
    return allow(`全局网络策略是「允许」，${info.subject}要联网，放行。`)
  }

  /* ⑥ 其余：先问 */
  const where =
    info.hosts.length > 0 ? `目标主机：${info.hosts.join('、')}` : '命令里没有能认出主机名的地方'
  return {
    action: 'ask',
    reason:
      `全局网络策略是「每次先问」，${info.subject}要联网，得先问过你。${where}。` +
      '要少问：把主机加进允许名单（security.network.allowHosts），或把整体策略改成「允许」。',
  }
}

/* ── 给界面看的那段人话 ──────────────────────────────────── */

/**
 * 界面上直接显示这段话。**「管不到什么」必须留着** ——
 * 声明得比实际强，用户就会拿它当防火墙，那比没有这道关更危险。
 * @param {object} [injected] 同 policyOf（测试用）
 */
const COVERAGE = [
  '能管到的：应用自己发起的网络请求、带联网语义的 shell 命令、要不要启动某个 MCP 服务器。',
  '管不到的：MCP 子进程自己发起的流量、浏览器标签页里的第三方脚本、你系统里别的程序。真正要拦网络得靠系统防火墙。',
  '另外：判定是命令文本上的正则（启发式，会漏）；主机名只做正则抠取，不做 DNS 解析。',
].join('\n')

function describePolicy(injected) {
  const policy = policyOf(injected)
  const lines = [`当前：${MODE_LABEL[policy.mode]}（security.network.mode）`]
  if (policy.denyHosts.length > 0) lines.push(`禁止名单：${policy.denyHosts.join('、')}`)
  if (policy.allowHosts.length > 0) lines.push(`允许名单：${policy.allowHosts.join('、')}`)
  lines.push(COVERAGE)
  return lines.join('\n')
}

module.exports = {
  /* 下面这几个是 `net-policy-patterns.cjs` 的，**转出来**让调用方只认一个入口
     （自检 73 组也直接调它们；拆文件不该把调用方一起拆散） */
  NET_RISK,
  detect,
  extractHosts,
  hostVerdict,
  mcpNeedsNetwork,
  /* 本地实现 */
  MODE_LABEL,
  mode,
  policyOf,
  decide,
  describePolicy,
}
