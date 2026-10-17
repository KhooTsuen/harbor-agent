/**
 * Codex ↔ Harbor 桥：**通道协议**（2026-10-17 第二阶段 · 生产版）
 *
 * ── 这个文件是什么 ────────────────────────────────────────────
 *
 * MCP server（独立进程，codex 拉起的）与 **Harbor 主进程侧宿主**（tools.execute
 * 的执行者）之间的那条本地进程通道。
 *
 * ── ★ 复用了什么（用户要求「复用现有进程通信和身份验证机制」）────
 *
 *   · **帧编码**：直接复用 `ext-protocol.cjs` 的 `encodeFrame` / `decodeFrames` ——
 *     与 Edge 扩展桥同一条实现（4 字节小端长度 + UTF-8 JSON 体）。
 *   · **token 机制**：同样是「16 字节随机 hex + 落 data 根 + fail-closed」，
 *     读不到 token 就拒绝一切请求（照 ext-protocol 的语义，不新造一套）。
 *   · **报文形状**：`P.request` / `P.reply` / `P.failure` 原样用。
 *
 * ── ★ 为什么不共用 Edge 桥的管道名 / token 文件 ────────────────
 *
 * `P.pipeName(dataDir)` 的前缀是 `harbor-ext-`，那是**浏览器扩展桥**的专用管道；
 * token 文件是 `ext-bridge.token`。两者是另一个功能的通道。若共用：两条不相干的
 * 通道会串台（谁先 listen 谁赢），token 也会互相顶掉。
 * 所以这里用**同样的机制、独立的名字**：前缀 `harbor-codex-mcp-`、
 * token 文件 `codex-mcp.token`。语义一字不差，通道互不干扰。
 *
 * ⚠️ 本模块**不 require electron**（要能在纯 Node 进程里跑）。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const net = require('node:net')

const P = require('./ext-protocol.cjs')

/** 管道名前缀（与 Edge 桥的 `harbor-ext-` 刻意区分） */
const PIPE_PREFIX = '\\\\.\\pipe\\harbor-codex-mcp-'

/** token 文件名（落在 data 根下，与「数据只落 data/」的硬约束一致） */
const TOKEN_FILE = 'codex-mcp.token'

/** MCP server 侧从环境变量拿「数据根是哪个」——由宿主启动 codex 时注入 */
const DATA_ENV = 'HARBOR_MCP_DATA'

/**
 * 管道名 —— **唯一真相源**。带 data 根路径的 hash，同机多安装不会串台。
 *
 * ★ **必须先归一化**（2026-10-17 端到端实测逮到）：同一个目录写成 `E:/a/b` 与
 *   `E:\a\b` 是同一个地方，但直接 hash 会得到两个不同的名字 —— 表现为
 *   「MCP server 连不上通道」（`ENOENT \\.\pipe\...`），而两边其实都好好的。
 *   所以统一成 `path.resolve` 之后的小写形式（Windows 路径大小写不敏感）。
 *
 * @param {string} dataDir
 */
function pipeName(dataDir) {
  let norm = String(dataDir ?? '')
  try {
    norm = path.resolve(norm)
  } catch {
    /* 解析不了就用原样（下面再去尾斜杠） */
  }
  norm = norm.replace(/[\\/]+$/, '').toLowerCase()
  const hash = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12)
  return `${PIPE_PREFIX}${hash}`
}

/** token 文件路径 */
function tokenPath(dataDir) {
  return path.join(String(dataDir ?? ''), TOKEN_FILE)
}

/**
 * 生成并写入本次启动的 token（每次启动都换，旧 token 立即失效）。
 * 写不进去 → 返回空串 → 通道拒绝一切请求（fail-closed）。
 * @param {string} dataDir
 */
function writeToken(dataDir) {
  const token = crypto.randomBytes(16).toString('hex')
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(tokenPath(dataDir), token, { encoding: 'utf8', mode: 0o600 })
    return token
  } catch {
    return ''
  }
}

/** 读 token；读不到返回空串（调用方据此拒绝 / 报错） */
function readToken(dataDir) {
  try {
    return fs.readFileSync(tokenPath(dataDir), 'utf8').trim()
  } catch {
    return ''
  }
}

/** 数据根：环境变量优先（MCP server 侧没有别的途径知道） */
function dataRootFromEnv() {
  return String(process.env[DATA_ENV] ?? '').trim()
}

/**
 * 经通道把一次工具调用交给 Harbor 侧宿主（**客户端侧唯一实现**；
 * `mcp-server-standalone.cjs` 与验收探针都用它，免得各写一份迟早漂）。
 *
 * @param {string} dataDir 数据根（管道名与 token 都按它算）
 * @param {string} tool
 * @param {object} args
 * @param {number} [timeoutMs]
 * @param {string} [tokenOverride] 只在「故意用错 token」的负向用例里传
 * @param {string} [runId] 发起这次调用的是**哪一轮对话**（审批卡按它绑定；缺省 = 空）
 * @returns {Promise<object>} 原始应答帧（`ok` / `payload` / `error`）
 */
function callTool(dataDir, tool, args, timeoutMs = 60_000, tokenOverride, runId = '') {
  return new Promise((resolve) => {
    const token = tokenOverride !== undefined ? String(tokenOverride) : readToken(dataDir)
    if (!token) {
      resolve({ ok: false, error: { code: 'NO_TOKEN', message: `读不到通道 token（${tokenPath(dataDir)}）` } })
      return
    }
    const id = `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const sock = net.connect(pipeName(dataDir))
    /** @type {Buffer} */ let buf = Buffer.alloc(0)
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        sock.destroy()
      } catch {
        /* 已经断了 */
      }
      resolve(value)
    }
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: { code: 'TIMEOUT', message: `Harbor 侧 ${Math.round(timeoutMs / 1000)} 秒内没回话` },
        }),
      timeoutMs,
    )
    sock.on('connect', () => {
      sock.write(P.encodeFrame(P.request({ id, kind: 'tool:call', payload: { tool, args, runId }, token })))
    })
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, /** @type {Buffer} */ (chunk)])
      const parsed = P.decodeFrames(buf)
      buf = parsed.rest
      for (const msg of /** @type {any[]} */ (parsed.messages)) {
        if (msg && msg.id === id) finish(msg)
      }
    })
    sock.on('error', (error) => {
      finish({
        ok: false,
        error: { code: 'NO_HARBOR', message: `连不上 Harbor 侧通道：${String(error?.message || error)}` },
      })
    })
  })
}

module.exports = {
  PIPE_PREFIX,
  TOKEN_FILE,
  DATA_ENV,
  callTool,
  pipeName,
  tokenPath,
  writeToken,
  readToken,
  dataRootFromEnv,
  /* 帧与报文形状：原样转发 ext-protocol 的实现（不重写） */
  encodeFrame: P.encodeFrame,
  decodeFrames: P.decodeFrames,
  request: P.request,
  reply: P.reply,
  failure: P.failure,
  ERR: P.ERR,
}
