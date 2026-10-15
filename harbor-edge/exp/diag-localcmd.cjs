/**
 * 本地预检：三个 .cmd 的 stdout 干不干净（不依赖 Edge，秒级）。
 * 判据：STDOUT 必须**恰好**是一帧（32 字节，`1c000000{...}`），不能有任何前缀。
 */

const { spawn } = require('node:child_process')

const CASES = [
  ['3a host-node.cmd', 'E:\\CodexWorkbench\\harbor-edge\\exp\\host-node.cmd'],
  ['3b host-electron-node.cmd', 'E:\\CodexWorkbench\\harbor-edge\\exp\\host-electron-node.cmd'],
  ['3c 同目录 harbor-host.cmd', 'E:\\CodexWorkbench\\dist-portable\\Harbor\\harbor-host.cmd'],
]

const EXPECT = '1c0000007b22706f6e67223a312c226563686f223a7b2270696e67223a317d7d'

function frame(obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8')
  const h = Buffer.alloc(4)
  h.writeUInt32LE(b.length, 0)
  return Buffer.concat([h, b])
}

function run(label, cmdPath) {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/c', cmdPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.on('error', (e) => {
      console.log(`\n── ${label} → ❌ spawn 错误：${e.message}`)
      resolve()
    })
    child.stdin.write(frame({ ping: 1 }))
    setTimeout(() => {
      const o = Buffer.concat(out)
      const hex = o.toString('hex')
      const ok = hex === EXPECT
      console.log(`\n── ${label} → ${ok ? '✅ 干净（恰好一帧）' : '❌ 不干净'} ──`)
      console.log(`   STDOUT hex = ${hex}`)
      if (!ok) console.log(`   期望       = ${EXPECT}`)
      const e = Buffer.concat(err).toString('utf8').replace(/\s+/g, ' ').slice(0, 200)
      if (e) console.log(`   STDERR = ${e}`)
      try {
        child.kill()
      } catch {
        /* */
      }
      resolve()
    }, 2500)
  })
}

async function main() {
  console.log('═══ 本地预检：.cmd 的 stdout 干净度 ═══')
  for (const [label, p] of CASES) await run(label, p)
}

main().catch((e) => console.log('ERR', e.message))
