/**
 * MCP：单个服务器连接
 *
 * 从 mcp.cjs 拆出来的（那边过 300 行了）。这里只管**一个**子进程的一生：
 * 起进程、握手、收发 JSON-RPC、拉工具清单、调用工具、杀掉。
 * 「有哪几个服务器、谁活着、工具怎么汇总」在 mcp.cjs。
 *
 * 传输：子进程的 stdin/stdout，每行一个 JSON（MCP 的 stdio 用的是换行分隔，
 * 不是 LSP 那种 Content-Length 头，这点容易搞混）。
 */

const { spawn } = require('node:child_process')
const { onAbort } = require('./abort.cjs')
const log = require('./log.cjs')
const { BRAND } = require('./config-defaults.cjs')

const PROTOCOL_VERSION = '2024-11-05'
const CALL_TIMEOUT_MS = 60_000
/** 单次工具调用的硬上限（用户没配的话用这个） */
const DEFAULT_CALL_TIMEOUT_MS = CALL_TIMEOUT_MS
const START_TIMEOUT_MS = 20_000

/* ══════════════════════════════════════════════════════════════
   单个连接
   ══════════════════════════════════════════════════════════════ */

/**
 * 环境变量名看起来像密钥吗。
 *
 * 「继承环境变量」模式下用它做最后一道过滤 —— 用户选了继承，
 * 但那不等于要把 OPENAI_API_KEY / AWS_SECRET_ACCESS_KEY 递给一个第三方程序。
 */
function isSecretEnvKey(name) {
  return /(api[_-]?key|secret|token|password|passwd|credential|private[_-]?key|access[_-]?key|session[_-]?token|auth)/i.test(
    String(name ?? ''),
  )
}

class McpConnection {
  constructor(config) {
    this.config = config
    this.id = config.id
    this.child = null
    this.nextId = 1
    /** id -> { resolve, reject, timer } */
    this.pending = new Map()
    this.buffer = ''
    this.tools = []
    this.alive = false
    this.error = ''
  }

  /**
   * 拼出给 MCP 子进程的环境变量。
   *
   * 规则：
   *   · `inheritEnvironment: false`（默认）→ 只给白名单里的键
   *   · 白名单默认是「让进程能跑起来」的最小集（PATH / SystemRoot / TEMP …）
   *   · 服务器自己配的 env **总是给**（那是用户显式填的）
   *   · 记录实际给出去的键名，诊断包里能看到「这个服务器拿到了什么」
   */
  buildEnv() {
    const allowed = new Set(this.config.envAllowlist ?? [])
    const out = {}

    if (this.config.inheritEnvironment) {
      /* 用户明确选择继承 —— 仍然把已知的密钥类变量滤掉 */
      for (const [key, value] of Object.entries(process.env)) {
        if (!isSecretEnvKey(key)) out[key] = value
      }
    } else {
      for (const key of allowed) {
        if (process.env[key] !== undefined) out[key] = process.env[key]
      }
    }

    /* 显式配置的 env 优先级最高，也允许它绕过过滤（用户自己填的） */
    for (const [key, value] of Object.entries(this.config.env ?? {})) {
      out[key] = String(value)
    }

    this.envKeys = Object.keys(out)
    return out
  }

  /** 启动进程并发起握手 */
  async start() {
    const { command, args = [], env = {} } = this.config
    const env2 = this.buildEnv()

    /*
     * MCP 服务器是**不可信扩展** —— 一个本地子进程，我们不知道它干什么。
     *
     * 以前这里是 `env: { ...process.env, ...env }`：把整个环境变量表
     * （包括所有 API Key、代理凭据、云厂商 token）递给一个第三方程序。
     * 现在只递给白名单里的那几个 —— 少了 SystemRoot / windir / PATH
     * 很多程序根本起不来，所以那几个是必需的；其余一律不给。
     */
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env2,
      /* 独立工作目录：不指定就用自己的工作目录，不用主进程的 */
      cwd: this.config.cwd || undefined,
      windowsHide: true,
      shell: process.platform === 'win32',
    })

    this.child.on('error', (error) => {
      this.error = error.message
      this.alive = false
      log.warn(`MCP「${this.id}」进程错误：${error.message}`)
    })

    this.child.on('exit', (code) => {
      this.alive = false
      /* 进程死了要把所有挂着的请求都放掉，否则调用方会一直等 */
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error(`MCP 服务器已退出（code ${code}）`))
      }
      this.pending.clear()
      log.info(`MCP「${this.id}」已退出（code ${code}）`)
    })

    this.child.stdout.on('data', (chunk) => this.onData(chunk))
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) log.info(`[MCP:${this.id}] ${text.slice(0, 300)}`)
    })

    await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: BRAND.id, version: require('../../package.json').version },
      },
      this.config.timeoutMs || START_TIMEOUT_MS,
    )

    /* 握手完成的确认通知（不需要回复） */
    this.notify('notifications/initialized', {})

    this.alive = true
    await this.refreshTools()
  }

  onData(chunk) {
    this.buffer += String(chunk)

    /* 换行分隔的 JSON；最后一段可能不完整，留在缓冲里 */
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      const text = line.trim()
      if (!text) continue
      let message
      try {
        message = JSON.parse(text)
      } catch {
        /* 有些服务器会往 stdout 打非 JSON 的日志，忽略即可 */
        continue
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)
        this.pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) entry.reject(new Error(message.error.message ?? 'MCP 返回错误'))
        else entry.resolve(message.result)
      }
    }
  }

  send(payload) {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error('MCP 进程不在')
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  request(method, params, timeoutMs = CALL_TIMEOUT_MS, signal) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      let settled = false
      /* 「谁先到算谁」：超时 / 中断 / 正常回包，只有第一个生效 */
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending.delete(id)
        off()
        fn(value)
      }
      const timer = setTimeout(
        () => settle(reject, new Error(`${method} 超时（${Math.round(timeoutMs / 1000)}s）`)),
        timeoutMs,
      )
      /*
       * AG-010：用户点停止就把这条挂着的请求撤掉。
       * 不撤的话它要等满超时（默认几十秒）才回来 —— 期间 Stop 看起来「没反应」，
       * 而且模型链路一直挂着。
       */
      const off = onAbort(signal, () => settle(reject, new Error('已被用户中断')))
      this.pending.set(id, {
        resolve: (value) => settle(resolve, value),
        reject: (error) => settle(reject, error),
        timer,
      })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        settle(reject, error)
      }
    })
  }

  notify(method, params) {
    try {
      this.send({ jsonrpc: '2.0', method, params })
    } catch {
      /* 通知失败无所谓 */
    }
  }

  async refreshTools() {
    const result = await this.request('tools/list', {})
    const list = Array.isArray(result?.tools) ? result.tools : []
    this.tools = list.map((tool) => ({
      /** 完整名：mcp__<server>__<tool>，避免和本地工具撞名 */
      fullName: `mcp__${this.id}__${tool.name}`,
      serverId: this.id,
      serverName: this.config.name || this.id,
      name: String(tool.name),
      description: String(tool.description ?? ''),
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    }))
    return this.tools
  }

  async call(toolName, args, signal) {
    /*
     * 每个服务器可以有自己的超时。默认 60 秒 ——
     * 没有超时的外部进程调用会把整个 Agent 循环挂死，
     * 这是 MCP 最常见的坑（服务器卡住但进程没退）。
     */
    const result = await this.request(
      'tools/call',
      { name: toolName, arguments: args ?? {} },
      this.config.timeoutMs || DEFAULT_CALL_TIMEOUT_MS,
      signal,
    )

    /* MCP 把工具输出放在 content 数组里，元素类型可能是 text / image / resource */
    const parts = Array.isArray(result?.content) ? result.content : []
    const texts = parts
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)

    if (texts.length === 0) {
      const other = parts.map((p) => p?.type).filter(Boolean)
      return other.length > 0
        ? `（工具返回了非文本内容：${other.join(', ')}）`
        : '（工具没有返回内容）'
    }

    const body = texts.join('\n')
    return result?.isError ? `工具报错：${body}` : body
  }

  stop() {
    this.alive = false
    try {
      this.child?.kill()
    } catch {
      /* 已经退了 */
    }
  }
}

module.exports = {
  McpConnection,
  isSecretEnvKey,
  PROTOCOL_VERSION,
  CALL_TIMEOUT_MS,
  DEFAULT_CALL_TIMEOUT_MS,
  START_TIMEOUT_MS,
}
