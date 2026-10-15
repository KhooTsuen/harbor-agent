/**
 * Phase 0 探针 · host 侧（用 node 跑，零依赖）
 *
 * ★ 它唯一的使命就是把**真实收到的 argv** 落盘 ——
 *   「host 清单的 path 能不能带命令行参数」这条，判据就是 argv 里有没有那个 marker。
 *
 * 协议照 Chromium 的：每条消息 = 4 字节小端长度 + UTF-8 JSON。
 * Windows 上官方特别提醒 I/O 必须是 binary 模式（Node 的 stdio 本来就不做 CRLF 转换）。
 */

const fs = require('node:fs')
const path = require('node:path')

const LOG = process.env.HARBOR_PHASE0_LOG || path.join(__dirname, 'host-report.json')
/* eslint-disable-next-line no-unused-vars */
const MARKER = '--harbor-marker=PHASE0'
/* stdout 必须是**纯二进制**（官方 Windows 提醒：I/O 不能走文本模式） */
try {
  if (process.stdout._handle && process.stdout._handle.setBlocking) {
    process.stdout._handle.setBlocking(true)
  }
} catch {
  /* 忽略 */
}

/** 追加一条记录（用数组，避免并发覆盖） */
function record(entry) {
  let all = []
  try {
    all = JSON.parse(fs.readFileSync(LOG, 'utf8'))
    if (!Array.isArray(all)) all = []
  } catch {
    /* 第一次 */
  }
  all.push(entry)
  try {
    fs.writeFileSync(LOG, JSON.stringify(all, null, 2))
  } catch {
    /* 忽略 */
  }
}

record({
  stage: 'started',
  at: new Date().toISOString(),
  argv: process.argv,
  /** ★ 核心判据：path 里带的那个 marker 有没有传进来 */
  markerSeen: process.argv.includes(MARKER),
  cwd: process.cwd(),
  node: process.version,
})

/** 给 Edge 回一条 */
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  process.stdout.write(Buffer.concat([head, body]))
}

let buf = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  /* ★ chunk 在某些模式下是字符串（管道 / 文本模式）—— Buffer.concat 不收字符串，
     必须显式转。第一版没转，真机上报 ERR_INVALID_ARG_TYPE。 */
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
  buf = Buffer.concat([buf, bytes])
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0)
    if (buf.length < 4 + len) break
    const text = buf.subarray(4, 4 + len).toString('utf8')
    buf = buf.subarray(4 + len)
    let message = null
    try {
      message = JSON.parse(text)
    } catch {
      message = { raw: text }
    }
    record({ stage: 'got-message', message })
    send({ pong: 1, echo: message, markerSeen: process.argv.includes(MARKER) })
  }
})

process.stdin.on('end', () => {
  record({ stage: 'stdin-ended' })
  process.exit(0)
})
