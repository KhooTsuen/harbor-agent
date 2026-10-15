/**
 * 诊断：把本地 spawn 时 host 的 stdout 原始字节 dump 出来。
 *
 * 为什么需要：exp1 的三组本地变体都"收到 34 字节"但按帧协议解不开。
 * 得先看清那 34 字节到底是什么，才知道是「stdout 被污染」还是「我的解码错了」。
 *
 * 正对照：node.exe 当 host（应完美回帧）—— 如果我连它都解不开，那是我的判据坏了。
 */

const { spawn } = require('node:child_process')

const HARBOR = 'E:\\CodexWorkbench\\dist-portable\\Harbor\\Harbor.exe'
const NODE = 'E:\\nodejs\\node.exe'
const PROBE = 'E:\\CodexWorkbench\\harbor-edge\\exp\\probe-host.cjs'

function frame(obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8')
  const h = Buffer.alloc(4)
  h.writeUInt32LE(b.length, 0)
  return Buffer.concat([h, b])
}

function run({ label, exe, args, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    const out = []
    const err = []
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.on('error', (e) => resolve({ label, spawnError: e.message }))
    try {
      child.stdin.write(frame({ ping: 1 }))
    } catch (e) {
      resolve({ label, writeError: e.message })
      return
    }
    setTimeout(() => {
      const o = Buffer.concat(out)
      const e = Buffer.concat(err)
      console.log(`\n══ ${label} ══`)
      console.log(`  STDOUT len=${o.length}`)
      console.log(`  STDOUT hex  = ${o.toString('hex')}`)
      console.log(`  STDOUT repr = ${JSON.stringify(o.toString('latin1'))}`)
      console.log(`  STDERR len=${e.length}`)
      console.log(`  STDERR      = ${JSON.stringify(e.toString('utf8').replace(/\s+/g, ' ').slice(0, 300))}`)
      try {
        child.kill()
      } catch {
        /* */
      }
      resolve({ label })
    }, 3000)
  })
}

async function main() {
  console.log('── 正对照：node.exe 当 host（应回 `{"pong":1,...}`）──')
  await run({ label: '正对照 node.exe + probe-host.cjs', exe: NODE, args: [PROBE] })

  console.log('\n── 被测：Harbor.exe 当 host（--parent-window=0）──')
  await run({ label: 'Harbor.exe 基线', exe: HARBOR, args: ['--parent-window=0'] })
}

main().catch((e) => console.log('ERR', e.message))
