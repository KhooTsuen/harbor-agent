/**
 * Phase 0 · 本地验证 native messaging 帧协议实现是否正确（不依赖 Edge）。
 *
 * 做法：起 probe-host.cjs 作为子进程，从 stdin 喂一个**正确的帧**
 *      （4 字节小端长度 + UTF-8 JSON），检查 stdout 回来的帧。
 *
 * 这样能把「协议实现对不对」和「Edge 能不能端到端跑通」分开验证 ——
 * 上一轮 Edge 那条报 "Error when communicating with the native messaging host"，
 * 怀疑是 node.exe 无参数时会**抢读 stdin 当脚本求值**（REPL/脚本模式），
 * 与我的监听冲突。这一条本地测能定性。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const BASE = 'E:\\CodexWorkbench\\harbor-edge\\phase0'
const HOST = path.join(BASE, 'probe-host.cjs')
const LOG = path.join(BASE, 'host-report-local.json')

try {
  fs.unlinkSync(LOG)
} catch {
  /* */
}

const child = spawn(process.execPath, [HOST], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, HARBOR_PHASE0_LOG: LOG },
})

const chunks = []
child.stdout.on('data', (b) => chunks.push(b))
child.stderr.on('data', (b) => console.log('  [host stderr]', b.toString().slice(0, 200)))

/** 按协议编码一帧 */
function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

setTimeout(() => {
  console.log('→ 发 {"ping":1}\n')
  child.stdin.write(frame({ ping: 1 }))
}, 600)

setTimeout(() => {
  const out = Buffer.concat(chunks)
  console.log(`← host stdout 共 ${out.length} 字节`)
  if (out.length >= 4) {
    const len = out.readUInt32LE(0)
    const body = out.subarray(4, 4 + len).toString('utf8')
    console.log(`  帧头声明的长度 = ${len}`)
    console.log(`  帧体 = ${body}`)
    try {
      const parsed = JSON.parse(body)
      console.log(`  ★ 解析成功：pong=${parsed.pong} echo=${JSON.stringify(parsed.echo)}`)
    } catch (e) {
      console.log(`  ✗ JSON 解析失败：${e.message}`)
    }
  } else {
    console.log('  ✗ stdout 没有完整帧')
  }

  console.log('\n=== host 侧日志 ===')
  if (fs.existsSync(LOG)) console.log(fs.readFileSync(LOG, 'utf8'))
  else console.log('（没有日志）')

  child.kill()
  process.exit(0)
}, 2200)
