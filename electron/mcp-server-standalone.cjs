/**
 * **MCP server（stdio）** —— codex 作为 MCP client 拉起它（2026-10-17 第二阶段）
 *
 * ── 职责（严格只有三件）─────────────────────────────────────────
 *
 *   ① **协议**：stdio 上按 MCP 规范收发（换行分隔 JSON-RPC）。
 *      实现 `initialize` / `notifications/initialized` / `tools/list` / `tools/call`。
 *   ② **参数校验**：见 `core/codex-mcp-tools.cjs`（形状层面）。
 *   ③ **转发**：把调用经本地进程通道交给 Harbor 主进程侧的桥，把结果原样带回。
 *
 * **它自己不执行任何 Harbor 工具** —— 没有 require 工具系统，也没有文件系统操作。
 * 真正的执行、路径授权、审计都在 Harbor 主进程（`core/codex-mcp-bridge.cjs`）。
 *
 * ── 通道与认证（复用现有机制）─────────────────────────────────
 *
 * 管道名与 token 由 `core/codex-mcp-protocol.cjs` 算（帧编码复用 `ext-protocol`）。
 * 每次调用都**带上 token**；主进程验不过就拒绝。token 从 `<数据根>/codex-mcp.token`
 * 读 —— 数据根由 argv[2] 指定（codex 用 `-c mcp_servers.harbor.args=[...]` 传），
 * 没给才退回环境变量 `HARBOR_MCP_DATA`。
 *
 * ⚠️ 不 require electron。stdout 是协议通道，**日志一律走 stderr**。
 */

const B = require('./core/codex-mcp-protocol.cjs')
const tools = require('./core/codex-mcp-tools.cjs')

const SERVER_NAME = 'harbor-bridge'
const SERVER_VERSION = '0.2.0'

/** 单次转发的等待上限（主进程那边还要跑工具，给宽一点） */
const CALL_TIMEOUT_MS = 60_000

/** 诊断日志一律走 stderr（stdout 只放协议报文） */
function note(message) {
  process.stderr.write(`[harbor-mcp] ${message}\n`)
}

/** tools/call 的结果 → MCP 的 content 形状 */
function textResult(text, isError) {
  return { content: [{ type: 'text', text: String(text ?? '') }], ...(isError ? { isError: true } : {}) }
}

/** 处理一条 JSON-RPC（返回 null = 不回）。`runId` = 发起这次调用的是哪一轮对话 */
async function handle(msg, dataDir, runId = '') {
  const id = msg?.id
  const method = String(msg?.method ?? '')

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    }
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) return null
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: tools.TOOLS } }
  }

  if (method === 'tools/call') {
    const name = String(msg?.params?.name ?? '')
    const clean = tools.cleanCall(name, msg?.params?.arguments ?? {})
    if (clean.ok !== true) {
      note(`参数被拒：${clean.message}`)
      return { jsonrpc: '2.0', id, result: textResult(`参数不合法：${clean.message}`, true) }
    }
    const res = await B.callTool(dataDir, name, clean.args ?? {}, CALL_TIMEOUT_MS, undefined, runId)
    if (!res || res.ok !== true) {
      const message = res?.error?.message ?? 'Harbor 侧没有回可用的结果'
      note(`转发失败：${message}`)
      return { jsonrpc: '2.0', id, result: textResult(`Harbor 拒绝了这次调用：${message}`, true) }
    }
    /*
     * ★ **工具层**：Harbor 工具**真的成功了吗**（见 codex-mcp-bridge.cjs 文件头 ③）。
     * 转发成功 ≠ 工具成功 —— 修正前这里一律报成功，于是 Codex 收到 `status=completed`
     * 加一段「错误：文件不存在…」的文案，**以为调用成功了**。这条就是那次修正。
     */
    const text = String(res.payload?.text ?? '')
    if (res.payload?.toolOk === false) {
      note(`工具执行失败（转发成功）：${text.slice(0, 120)}`)
      return { jsonrpc: '2.0', id, result: textResult(`Harbor 工具执行失败：\n${text}`, true) }
    }
    return { jsonrpc: '2.0', id, result: textResult(text) }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
}

function main() {
  /* ★ 数据根优先从 argv 拿：codex 通过 `-c mcp_servers.<name>.args=[...]` 传参最稳，
     不必走 TOML 的 env 表（那在 cmd 里有引号地狱）。没给才退回环境变量。 */
  const dataDir = String(process.argv[2] ?? '').trim() || B.dataRootFromEnv()
  if (!dataDir) {
    note(`缺少数据根（argv[2] 或 ${B.DATA_ENV}）—— 不知道连哪个 Harbor，拒绝启动`)
    process.exit(2)
  }
  /*
   * 发起这次运行的**那一轮对话**（argv[3]）—— 每次 `codex exec` 都带一个，
   * 桥按它把审批卡绑定到正确的对话上（见 codex-mcp-context.cjs）。
   * 形状不合法就当作空（桥那边拿不到上下文 → 写类调用被拒，fail-closed）。
   */
  const rawRunId = String(process.argv[3] ?? '').trim()
  const runId = require('./core/codex-mcp-context.cjs').RUN_ID_RE.test(rawRunId) ? rawRunId : ''
  note(`已启动（数据根 = ${dataDir}，运行 = ${runId || '(无)'}，管道 = ${B.pipeName(dataDir)}）`)

  let buf = ''
  /** 还没回完的请求数 + 还没 flush 的输出 + stdin 是否已结束 —— 见 `maybeExit` */
  let inFlight = 0
  let pendingWrite = 0
  let ended = false
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
      if (!line) continue
      let msg = null
      try {
        msg = JSON.parse(line)
      } catch {
        note(`收到非 JSON 的一行，已跳过（${line.slice(0, 80)}）`)
        continue
      }
      inFlight += 1
      void handle(msg, dataDir, runId)
        .then((reply) => {
          if (!reply) return
          /* ★ 盯着**写完**再算完 —— 见 maybeExit 的注释 */
          pendingWrite += 1
          process.stdout.write(`${JSON.stringify(reply)}\n`, () => {
            pendingWrite -= 1
            maybeExit()
          })
        })
        .catch((error) => note(`处理失败：${String(error?.message || error)}`))
        .finally(() => {
          inFlight -= 1
          maybeExit()
        })
    }
  })
  /*
   * ★ stdin 结束 = 调用方走了。**不能立刻 exit** —— 异步的 handle 可能还没回，
   *   那样最后一条结果会**凭空消失**（2026-10-17 验收实测：一次 `tools/call` 的
   *   响应还没写出去，进程已经被 `process.exit(0)` 掐了）。
   * 所以：还有在飞的请求就等它们回完（最多 5 秒，防永不退出）。
   */
  function maybeExit() {
    if (!ended || inFlight > 0 || pendingWrite > 0) return
    process.exit(0)
  }
  process.stdin.on('end', () => {
    ended = true
    if (inFlight > 0 || pendingWrite > 0) {
      note(`stdin 已结束，但还有 ${inFlight} 个请求 / ${pendingWrite} 段输出没完 —— 等它们`)
      /* 兜底：不许为了等一个卡住的请求永不退出 */
      setTimeout(() => process.exit(0), 5000).unref?.()
      return
    }
    process.exit(0)
  })
}

main()
