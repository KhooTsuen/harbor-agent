/**
 * 实验 3 的 host：纯 Node 帧回显。由 host.cmd 调用（cmd 文件自己会带对路径）。
 * 这里不需要任何 argv 判据 —— 这个探针的**唯一用途**就是当 host。
 */
const fs = require('node:fs')

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
    send(msg && typeof msg === 'object' && 'ping' in msg ? { pong: 1, echo: msg } : { error: 'exp3 只认 ping', echo: msg })
  }
})

process.stdin.on('end', () => process.exit(0))
