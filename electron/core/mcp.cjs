/**
 * MCP 客户端（Model Context Protocol）
 *
 * 只实现真正用得到的部分：**stdio 传输 + 工具**。
 * resources / prompts / 采样回调这些先不做 —— 没有实际用途之前不值得写。
 *
 * 单个连接的一生在 mcp-connection.cjs（起进程、握手、JSON-RPC、超时）。
 * 这一个文件是**连接池**：有哪几个服务器、谁活着、工具怎么汇总、什么时候重启。
 *
 * 生命周期：启动时把所有 enabled 的服务器拉起来、缓存工具清单。
 * 之所以「预加载」而不是「用到再连」，是因为工具清单要同步喂给
 * tools.toApiSchema()，而那是同步函数。
 */

const log = require('./log.cjs')
const { McpConnection, PROTOCOL_VERSION } = require('./mcp-connection.cjs')

/* ══════════════════════════════════════════════════════════════
   连接池
   ══════════════════════════════════════════════════════════════ */

/** serverId -> McpConnection */
const connections = new Map()

/** 已启动过的配置指纹，用来判断要不要重启 */
let lastFingerprint = ''

function fingerprint(servers) {
  return JSON.stringify(
    servers
      .map((s) => [s.id, s.command, s.args, s.env, s.enabled])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  )
}

/** 启动配置里所有 enabled 的服务器 */
async function startAll(servers) {
  const next = fingerprint(servers)
  if (next === lastFingerprint && connections.size > 0) return status()

  stopAll()
  lastFingerprint = next

  const enabled = (servers ?? []).filter((s) => s.enabled && s.command)
  if (enabled.length === 0) return status()

  await Promise.all(
    enabled.map(async (server) => {
      const conn = new McpConnection(server)
      try {
        await conn.start()
        connections.set(server.id, conn)
        log.info(`MCP「${server.id}」已连接，${conn.tools.length} 个工具`)
      } catch (error) {
        conn.error = error instanceof Error ? error.message : String(error)
        /* 失败也留在表里 —— 设置页要显示「为什么没起来」 */
        connections.set(server.id, conn)
        log.warn(`MCP「${server.id}」启动失败：${conn.error}`)
      }
    }),
  )

  return status()
}

function stopAll() {
  for (const conn of connections.values()) conn.stop()
  connections.clear()
}

function status() {
  return [...connections.values()].map((conn) => ({
    id: conn.id,
    name: conn.config.name || conn.id,
    alive: conn.alive,
    error: conn.error,
    toolCount: conn.tools.length,
    tools: conn.tools.map((t) => ({ name: t.name, description: t.description })),
  }))
}

/** 所有 MCP 工具（展开成统一格式） */
function listTools() {
  const out = []
  for (const conn of connections.values()) {
    if (conn.alive) out.push(...conn.tools)
  }
  return out
}

/** 按完整名调用；名字不是 MCP 工具时返回 null（交给本地工具处理） */
async function callTool(fullName, args, signal) {
  for (const conn of connections.values()) {
    const tool = conn.tools.find((t) => t.fullName === fullName)
    if (!tool) continue
    if (!conn.alive) throw new Error(`MCP 服务器「${conn.id}」不在运行`)
    return await conn.call(tool.name, args, signal)
  }
  return null
}

/** 启动时初始化（app ready 之后调） */
async function boot(configModule) {
  try {
    const servers = configModule.get().mcp?.servers ?? []
    await startAll(servers)
  } catch (error) {
    log.warn(`MCP 初始化失败：${error instanceof Error ? error.message : error}`)
  }
}

module.exports = {
  boot,
  startAll,
  stopAll,
  status,
  listTools,
  callTool,
  PROTOCOL_VERSION,
}
