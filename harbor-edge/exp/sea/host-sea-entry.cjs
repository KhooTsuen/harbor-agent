/**
 * SEA 入口：**自包含**的最简 host。
 *
 * 为什么自包含：SEA 里的 `require` 只认内置模块（外部文件要靠 sea.getAsset 塞进
 * blob）—— 为了让实验 2 聚焦「PE 子系统 / stdout 连通性」，这里不 require 任何
 * 外部文件，只用 process 内置能力。
 */

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  process.stdout.write(Buffer.concat([head, body]))
}

let buf = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
  buf = Buffer.concat([buf, bytes])
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0)
    if (len > 1024 * 1024) break
    if (buf.length < 4 + len) break
    const text = buf.subarray(4, 4 + len).toString('utf8')
    buf = buf.subarray(4 + len)
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      msg = { raw: text }
    }
    send(msg && typeof msg === 'object' && 'ping' in msg ? { pong: 1, echo: msg } : { error: 'sea 只认 ping', echo: msg })
  }
})

process.stdin.on('end', () => process.exit(0))
