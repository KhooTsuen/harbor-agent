/**
 * 配置：网络策略段的默认值
 *
 * 单独一个文件，理由有两条：
 *
 * ① `config-defaults.cjs` 加完这一段就过 300 行了（硬约束 #2）。按职责切是
 *    这个仓库拆文件的惯例 —— 而这一段确实是一件独立的事：它由 `net-policy.cjs`
 *    读、被 `run_shell` 和 MCP 启动门执行，和「工具权限 / 上下文预算」不是一回事。
 *
 * ② 这段注释**就是这段配置的说明书**。放在默认值旁边，改默认值的人一定会看到
 *    「管不到什么」那段话 —— 挪到别处（比如文档）就会漂。
 *
 * ── 为什么要有它 ──
 *
 * 以前「网络」只有两个处不着的开关：MCP 服务器自己的 `network` 字段（2026-09-24
 * 查出来**没有任何代码读过它**）、技能的 `network: deny` 声明（只是声明）。
 * 现在全局策略这一层是**真的会执行**的：`run_shell` 执行前、MCP 启动前各过一道。
 *
 * ⚠️ 如实说明管不到什么（`net-policy.describePolicy()` 会把这段话显示给用户）：
 *   能管到的：应用自己发起的网络请求、带联网语义的 shell 命令、要不要启动某个
 *            MCP 服务器。
 *   管不到的：MCP 子进程自己发起的流量、浏览器标签页里的第三方脚本、
 *            你系统里别的程序。真正要拦网络得靠系统防火墙。
 */

const NETWORK_MODES = ['allow', 'ask', 'deny']

/* ── 规范化 ──────────────────────────────────────────────────
 *
 * 三个一行的帮手在这里**再写一遍**，不从 `config-normalize.cjs` 引：
 * 那个文件要 require 本文件，反过来引就成环。它们都是稳定的一行判断，
 * 重复的代价远小于一个环。
 */

const obj = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const str = (value) => (typeof value === 'string' ? value : '')
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)

/**
 * 主机名单。
 *
 * 去重 + 去空白 + 设长度上限：这个列表**每次判断网络动作都要过一遍**，
 * 用户粘一坨东西进来会拖慢每一次工具调用。**不校验域名格式** ——
 * 校验错了会把合法写法（`*.corp.local`、IP、带端口）挡在外面，
 * 而这里的目的是「拦住」，宁可多留一条。
 */
function hostList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  for (const item of value) {
    const text = String(item ?? '')
      .trim()
      .toLowerCase()
    if (text && text.length <= 253) seen.add(text)
    if (seen.size >= 100) break
  }
  return [...seen]
}

/**
 * 规范化 `security` 段。
 *
 * ⚠️ `config-normalize.cjs` 的 `normalize()` 是**显式列字段**的白名单：
 *   不在这里列出来，设置页写进去的值会被静默丢掉，用户看到的是一个
 *   「设了没反应」的开关 —— 比没有这个设置更糟。加了新设置要同步这里。
 *
 * @param {unknown} raw `config.json` 里的 `security` 段（可能是任何东西）
 */
function normalizeSecurity(raw) {
  const network = obj(obj(raw).network)
  return {
    /*
     * 会话加密开关。**只认 `=== true`** —— 写别的（`'yes'`、`1`）一律当关。
     * 这个开关决定「要不要重写用户的全部会话文件」，宁可因为写错而没加密，
     * 也不要因为写错而把数据改了。
     */
    encryptSessions: obj(raw).encryptSessions === true,
    network: {
      /* 写错 / 缺失一律按 'ask'（fail-closed —— 绝不因为写错就放行） */
      mode: pick(str(network.mode) || 'ask', NETWORK_MODES, 'ask'),
      /* 两个名单都命中时**禁止优先**（判断顺序在 net-policy.decide） */
      denyHosts: hostList(network.denyHosts),
      allowHosts: hostList(network.allowHosts),
    },
  }
}

/** `security` 段的默认值（形状与上面的规范化输出**必须**一致） */
const SECURITY_DEFAULTS = {
  /*
   * 会话内容在磁盘上加密（逐行封印，见 `session-crypto.cjs`）。
   *
   * ⚠️ **默认 false，而且这个默认值是刻意的。** 开启会**重写用户已有的全部会话文件**
   *    —— 按硬约束 #5，那是一次大规模数据改动。默认开等于用户升级一次就被静默重写了
   *    全部聊天记录。所以做成显式开启，且开启时自动先备份。
   */
  encryptSessions: false,
  network: {
    /** 'allow' = 不问就放行；'ask' = 每次先问（默认）；'deny' = 一律不许 */
    mode: 'ask',
    /** 一律不许连的主机，支持 '*.example.com'。**禁止优先于允许** */
    denyHosts: [],
    /** 免问的主机；必须命令里**每个**主机都在名单里才算数 */
    allowHosts: [],
  },
}

module.exports = { NETWORK_MODES, SECURITY_DEFAULTS, normalizeSecurity, hostList }
