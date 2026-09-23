/**
 * MCP 服务器的网络门（启动前）
 *
 * `mcp.cjs` 的 `startAll` 用它：**启动之前**先问一遍 `net-policy.cjs`。
 * 被拦下的服务器不启动，但**仍然留在连接表里**（带 `error` / `blockedReason`）——
 * 和「启动失败」一个待遇，设置页才能显示「为什么它没起来」。
 *
 * ⚠️ 三句实话，别在界面上说软：
 *   · 这里的「管住」只到**启动之前**：stdio 子进程一旦跑起来，它自己发的包内核看不见
 *     （`statusOf` 会如实标 `uncontrolled`）。
 *   · 能真正兑现的是**明确说了「不给网络」的声明**（`network: 'deny'`）和**全局「禁止」**。
 *   · `network: 'ask'` 在启动阶段**没法问**（这里没有确认界面）。所以它**放行**，并把
 *     「这次没问成」如实写进 `statusOf().note` —— 既不能因为问不成就把用户自己配的
 *     server 静默停掉（那等于升级即失效），也不能假装问过了。
 */

const netPolicy = require('./net-policy.cjs')

/** 声明值归一化：兼容布尔写法（`network: false` 是老字段形状）和字符串档 */
function declarationOf(server) {
  const raw = server?.network
  if (raw === false) return 'deny'
  if (raw === true) return 'allow'
  const text = String(raw ?? '').trim().toLowerCase()
  if (text === 'deny' || text === 'block') return 'deny'
  if (text === 'allow') return 'allow'
  return 'ask' /* 没写 / 认不出来 → ask（保守） */
}

/** 这个服务器要不要联网：url / http 类传输 / 命令行本身是联网命令 */
function needsNetwork(server) {
  return netPolicy.mcpNeedsNetwork(server)
}

/** 为什么说它要联网（理由里的人话） */
function whyNetwork(server) {
  const s = server ?? {}
  if (typeof s.url === 'string' && s.url) return `它配了 url：${s.url.slice(0, 120)}`
  const transport = String(s.transport ?? s.type ?? '')
  if (transport) return `它的传输方式是 ${transport}`
  return `它的启动命令本身要联网（${String(s.command ?? '')} 之类会去下载）`
}

/**
 * 网络状态：`'controlled' | 'uncontrolled' | 'blocked'`，附一句为什么。
 * @returns {{ status: 'controlled'|'uncontrolled'|'blocked', note: string }}
 */
function statusOf(server) {
  const s = server ?? {}
  if (!needsNetwork(s)) {
    return {
      status: 'uncontrolled',
      note: '纯 stdio 子进程：它自己发起的流量内核看不见、拦不住（真要拦网络得靠系统防火墙）。',
    }
  }
  if (declarationOf(s) === 'deny') {
    return { status: 'blocked', note: '它的 network 声明是「禁止」，但它需要联网 —— 按声明不启动。' }
  }

  /*
   * `allow` = 用户明确说了「允许联网」（声明被兑现 → controlled）；
   * `ask` = 声明是「每次先问」，而启动阶段**没有确认界面** —— 这次没问成，
   *         所以如实标 `uncontrolled`，并在 note 里说清楚「没兑现」和「怎么办」。
   */
  if (declarationOf(s) === 'allow') {
    return {
      status: 'controlled',
      note: '它的 network 声明是「允许」，按声明放行；进程跑起来之后它自己发起的流量仍然看不见。',
    }
  }

  return {
    status: 'uncontrolled',
    note:
      '它的 network 声明是「每次先问」，但启动阶段没有确认界面 —— 这次没能问你（已放行）。' +
      '要真正拦住：把它改成「禁止」，或把全局策略改成「禁止」。进程内部的流量内核也看不见。',
  }
}

/**
 * 过一遍要启动的服务器。
 * @param {Array<object>} servers
 * @param {object} [ctx] 传给 `net-policy.decide`（测试注入策略用）
 * @returns {{ allowed: object[], blocked: Array<{ id: string, name: string, reason: string }> }}
 */
function guardServers(servers, ctx = {}) {
  const allowed = []
  const blocked = []

  for (const server of Array.isArray(servers) ? servers : []) {
    const s = server ?? {}
    if (s.enabled === false) continue
    /* 没有启动方式的不管（startAll 也会跳过） */
    if (!s.command && !s.url) continue

    const id = String(s.id ?? '')
    const name = String(s.name || s.id || '未命名')

    if (!needsNetwork(s)) {
      allowed.push(server)
      continue
    }

    /* ① 服务器自己的声明是「禁止」→ 直接拦，不看全局设置 */
    if (declarationOf(s) === 'deny') {
      blocked.push({
        id,
        name,
        reason:
          `它的 network 声明是「禁止」，但启动它需要联网（${whyNetwork(s)}）—— 按声明不启动。` +
          '要启动：把这个服务器的 network 改成「允许」，或换一个不需要联网的启动方式。',
      })
      continue
    }

    /* ② 全局策略（mode / 主机名单）说了算 */
    const decided = netPolicy.decide({ kind: 'mcp', target: s, ctx })
    if (decided.action === 'deny') {
      blocked.push({ id, name, reason: `被网络策略拦下：${decided.reason}` })
      continue
    }

    /*
     * ③ 其余一律放行 —— **包括 `'ask'`**。
     *
     * ★ 为什么不是「问不成就拦」：`network` 的默认值就是 `'ask'`（见
     *   `config-normalize.cjs`），也就是说**每一个已经配好的 MCP 服务器都是这个值**。
     *   按「问不成 → 不启动」处理，等于用户升级一次就把自己配的 server 全静默关掉，
     *   而且日志里只有一句 warn —— 那是比漏拦更糟的错（这个项目为同类事故付过代价）。
     *   所以：放行，把「这次没问成」如实写进 `statusOf().note`，让设置页说真话。
     */
    allowed.push(server)
  }

  return { allowed, blocked }
}

module.exports = { declarationOf, needsNetwork, statusOf, guardServers }
