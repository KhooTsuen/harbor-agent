/**
 * 扩展通道协议（Phase 3a）—— host ↔ 主进程之间的**唯一约定**
 *
 * ── 它是什么 ─────────────────────────────────────────────────
 *
 * 原来 host 只会「写完就走」（单向写管道，读不到回复）。Phase 3a 起要双向：
 * 扩展问一句、主进程答一句。这一份模块就是那条通道的**全部约定**：
 *   · **帧格式**：4 字节小端长度 + UTF-8 JSON 体（与 Edge native messaging 同构）
 *   · **报文形状**：请求 / 应答 / 错误应答 / 主动推送
 *   · **错误码**：两侧共用的那一份
 *   · **管道名与 token**：谁都得用这里的函数算，不许各写一份
 *
 * ── 为什么单列一个模块（硬约束 #9：跨模块口径只有一处真相源）──
 *
 * 这些东西**两侧都要用**：host 进程（ext-client / ext-host-loop）与主进程
 * （ext-bridge）。各写一份就会漂 —— 而漂在这里的后果是「协议对不上，链路直接不通」，
 * 且只会在**真机上**现形（两侧各自的单测都自洽）。所以只定义一次。
 *
 * ⚠️ 本模块**不 require electron**（host 进程要 require 它）。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/* ══════════════════════════════════════════════════════════════
   常量
   ══════════════════════════════════════════════════════════════ */

/** 协议版本。报文里的 `v`。将来改形状靠它分流（3a 只有 1） */
const V = 1

/** Edge native messaging 的单帧上限（官方：host → Edge 1 MB） */
const MAX_FRAME = 1024 * 1024

/**
 * **管道**帧上限（2 MB）—— 比 Edge 那侧宽，是故意的：`ext:page` 的正文在扩展侧
 * 已截到 512 KB，但 JSON 转义（引号 / 换行 / 反斜杠）会膨胀，极端内容接近 1 MB。
 * 管道是我们自己的（不经 Chromium），给 2 MB 余量；超了判 fatal 断开。
 */
const MAX_PIPE_FRAME = 2 * 1024 * 1024

/**
 * host 等主进程应答的期限（8 秒）—— `session:list` 是本地读盘，正常 < 50ms；
 * 给到 8s 是容忍「主进程正在跑重活」这类偶发卡顿。扩展侧另有 15s 上限（故意更长），
 * 让 host **先**超时、回一条带 code 的人话，比扩展自己超时（看不到原因）有用。
 */
const HOST_TIMEOUT_MS = 8000

/** 消息类型（kind）—— 两侧共用。3a 只有前两个走管道 */
const KIND = {
  /** 扩展读到的页面内容 → 落会话（Phase 2 起） */
  EXT_PAGE: 'ext:page',
  /** 会话列表（Phase 3a 新增） */
  SESSION_LIST: 'session:list',
}

/**
 * 错误码 —— **唯一清单**。侧边栏文案由扩展侧渲染（它跑在浏览器里，require 不到
 * 这个模块），但**码**是契约：只有这里有定义，两侧的行为分支都按它。
 */
const ERR = {
  NO_HARBOR: 'NO_HARBOR', /* Harbor 没在运行（管道不存在） */
  TIMEOUT: 'TIMEOUT', /* 主进程没在期限内回 */
  BAD_TOKEN: 'BAD_TOKEN', /* token 不对 */
  BAD_FRAME: 'BAD_FRAME', /* 帧解不开 */
  UNKNOWN_KIND: 'UNKNOWN_KIND', /* 不认识的 kind */
  INTERNAL: 'INTERNAL', /* 处理时抛异常 */
  TOO_LARGE: 'TOO_LARGE', /* 超出单帧上限 */
}

/* ══════════════════════════════════════════════════════════════
   帧编解码 —— 纯函数，不碰流（自检能在纯 Node 里直接跑）
   ══════════════════════════════════════════════════════════════ */

/**
 * 把一条消息编成一帧：**4 字节小端长度 + UTF-8 JSON 体**。
 *
 * @param {unknown} message
 * @returns {Buffer}
 */
function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message) ?? 'null', 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

/**
 * 从字节流里切出**尽可能多的完整帧**。
 *
 * 为什么增量：`data` 事件**不保证一次给一整帧** —— 可能半帧（等下一块）、
 * 也可能一次给三帧（粘包）。调用方把没吃完的尾巴留着，下次接在前面。
 *
 * @param {Buffer} buf 累积的字节
 * @param {{ max?: number }} [opts]
 * @returns {{ messages: unknown[], rest: Buffer, errors: string[], fatal: boolean }}
 *   `fatal` = 帧头声明了不可能的长度（协议没法对齐了，只能断）
 */
function decodeFrames(buf, opts = {}) {
  const max = Number(opts.max) > 0 ? Number(opts.max) : MAX_FRAME
  const messages = []
  const errors = []
  let offset = 0
  let fatal = false

  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? [])

  while (data.length - offset >= 4) {
    const len = data.readUInt32LE(offset)
    if (len > max) {
      /* 长度离谱：再往后读也没法对齐（不知道真实边界在哪），只能断 */
      errors.push(`帧长 ${len} 超过上限 ${max}`)
      fatal = true
      offset = data.length
      break
    }
    /* 半帧：留着等下一块，不要提前消费 */
    if (data.length - offset - 4 < len) break

    const body = data.subarray(offset + 4, offset + 4 + len)
    offset += 4 + len
    try {
      messages.push(JSON.parse(body.toString('utf8')))
    } catch (error) {
      errors.push(`帧体不是 JSON：${error instanceof Error ? error.message : error}`)
    }
  }

  return { messages, rest: data.subarray(offset), errors, fatal }
}

/* ══════════════════════════════════════════════════════════════
   报文形状 —— 构造与判据
   ══════════════════════════════════════════════════════════════ */

/**
 * host → 主进程：请求
 *
 * 解构参数一律给默认值 —— 不只为省事：`checkJs` 下无默认值的解构属性会被当成
 * **必填**，调用方少传一个 `ts` 就报 TS2345（内核类型检查会红）。
 *
 * @param {{ id?: string, kind?: string, payload?: object, token?: string, ts?: number }} [input]
 */
function request({ id = '', kind = '', payload = {}, token = '', ts = Date.now() } = {}) {
  return { v: V, token: String(token), id: String(id), kind: String(kind), payload, ts }
}

/**
 * 主进程 → host：成功应答
 *
 * @param {{ id?: string, kind?: string, payload?: object }} [input]
 */
function reply({ id = '', kind = '', payload = {} } = {}) {
  return { v: V, id: String(id), kind: String(kind), ok: true, payload }
}

/**
 * 主进程 → host：错误应答
 *
 * @param {{ id?: string, kind?: string, code?: string, message?: string }} [input]
 */
function failure({ id = '', kind = '', code = '', message = '' } = {}) {
  return {
    v: V,
    id: String(id),
    kind: String(kind),
    ok: false,
    error: { code: String(code || ERR.INTERNAL), message: String(message || '未知错误') },
  }
}

/**
 * 主进程 → host：**主动推送**（3b 的流式分片用；3a 不调，但形状现在定死）。
 *
 * ★ 推送与应答靠「有没有 `id`」区分：有 `id` = 应答；没有 = 推送。
 *   这条现在不写进代码注释就会被后人再改一次协议。
 *
 * @param {{ kind?: string, payload?: object }} [input]
 */
function push({ kind = '', payload = {} } = {}) {
  return { v: V, push: true, kind: String(kind), payload }
}

/**
 * 是不是一条「新协议」报文（请求或应答）—— 判据是**有 `id`**。
 *
 * ⚠️ 比设计说明 §6.1 的「有 `id` 且有 `kind`」**宽一点**，是故意的：
 *    `kind` 缺失/不认识时，还得能回一条 **UNKNOWN_KIND** —— 而那也必须走**帧**
 *    （回裸 JSON 的话，保持连接的 host 根本解不开，请求就永远等不到应答）。
 *    所以「有 `id`」才是「该回帧」的精确判据。
 */
function isProtocolFrame(message) {
  return (
    Boolean(message) &&
    typeof message === 'object' &&
    typeof message.id === 'string' &&
    message.id.length > 0
  )
}

/** 是不是应答（有 id，且带 ok） */
function isReply(message) {
  return isProtocolFrame(message) && typeof message.ok === 'boolean'
}

/** 是不是推送（没有 id，带 push 标记） */
function isPush(message) {
  return Boolean(message) && typeof message === 'object' && message.push === true && !isProtocolFrame(message)
}

/* ══════════════════════════════════════════════════════════════
   管道名与 token —— host 与主进程都得用这里的函数算
   ══════════════════════════════════════════════════════════════ */

/** 管道名前缀。Windows 命名管道的固定前缀，改不了 */
const PIPE_PREFIX = '\\\\.\\pipe\\harbor-ext-'

/** token 文件名（落在 data/ 下，与 path 硬约束一致） */
const TOKEN_FILE = 'ext-bridge.token'

/** 数据根的环境变量名（由 harbor-host.cmd 用 %~dp0 传入） */
const DATA_ENV = 'HARBOR_DATA_ROOT'

/**
 * 管道名 —— **唯一真相源**。
 *
 * 为什么带 hash：同一台机器上可能有多个 Harbor 安装（不同 data 根），
 * 固定名字会互相串台。用 data 根路径的 hash 区分。
 *
 * @param {string} dataDir 数据根目录
 * @returns {string}
 */
function pipeName(dataDir) {
  const hash = crypto.createHash('sha1').update(String(dataDir ?? '')).digest('hex').slice(0, 12)
  return `${PIPE_PREFIX}${hash}`
}

/** token 文件路径 */
function tokenPath(dataDir) {
  return path.join(String(dataDir ?? ''), TOKEN_FILE)
}

/**
 * 生成并写入本次启动的 token（每次启动都换，旧 token 立即失效）。
 *
 * @param {string} dataDir
 * @returns {string} token（写不进去返回空串 → 桥拒绝一切消息，fail-closed）
 */
function writeToken(dataDir) {
  const token = crypto.randomBytes(16).toString('hex')
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    /* mode 在 Windows 上被忽略，写上是为了在别的平台上也是对的 */
    fs.writeFileSync(tokenPath(dataDir), token, { encoding: 'utf8', mode: 0o600 })
    return token
  } catch {
    return ''
  }
}

/** 读 token（host 侧用；读不到返回空串） */
function readToken(dataDir) {
  try {
    return fs.readFileSync(tokenPath(dataDir), 'utf8').trim()
  } catch {
    return ''
  }
}

module.exports = {
  V,
  MAX_FRAME,
  MAX_PIPE_FRAME,
  HOST_TIMEOUT_MS,
  KIND,
  ERR,
  encodeFrame,
  decodeFrames,
  request,
  reply,
  failure,
  push,
  isProtocolFrame,
  isReply,
  isPush,
  PIPE_PREFIX,
  TOKEN_FILE,
  DATA_ENV,
  pipeName,
  tokenPath,
  writeToken,
  readToken,
}
