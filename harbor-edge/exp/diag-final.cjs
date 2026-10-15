/**
 * 补充诊断（三组实验收口用）：
 *
 * ① 3a 为什么失败？本地 spawn `host-node.cmd` 看 stdout/stderr 原始字节。
 *    （Phase 0 的 .cmd+node 形态曾通过 —— 差异必须查清，否则报告站不住）
 * ② 有没有开关能消掉 Harbor.exe 启动时那个 `\r\n`？（实验 1 的补充候选）
 *    ELECTRON_ENABLE_LOGGING=0 / --enable-logging=file --log-file=... 
 */

const { spawn } = require('node:child_process')

const HARBOR = 'E:\\CodexWorkbench\\dist-portable\\Harbor\\Harbor.exe'
const CMD_NODE = 'E:\\CodexWorkbench\\harbor-edge\\exp\\host-node.cmd'
const CMD_ELNODE = 'E:\\CodexWorkbench\\harbor-edge\\exp\\host-electron-node.cmd'
const LOGFILE = 'E:\\CodexWorkbench\\harbor-edge\\exp\\sea\\chromium.log'

function frame(obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8')
  const h = Buffer.alloc(4)
  h.writeUInt32LE(b.length, 0)
  return Buffer.concat([h, b])
}

function run({ label, exe, args, env = {}, send = true, wait = 3500 }) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    const out = []
    const err = []
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.on('error', (e) => {
      console.log(`\n══ ${label} ══\n  spawn 错误 = ${e.message}`)
      resolve()
    })
    child.on('exit', (code, sig) => {
      /* 早退也要说 */
      console.log(`  （进程退出 code=${code} sig=${sig}）`)
    })
    if (send) child.stdin.write(frame({ ping: 1 }))

    setTimeout(() => {
      const o = Buffer.concat(out)
      const e = Buffer.concat(err)
      console.log(`\n══ ${label} ══`)
      console.log(`  STDOUT len=${o.length}  hex=${o.toString('hex')}`)
      console.log(`  STDOUT repr=${JSON.stringify(o.toString('latin1'))}`)
      console.log(`  STDERR=${JSON.stringify(e.toString('utf8').replace(/\s+/g, ' ').slice(0, 240))}`)
      try {
        child.kill()
      } catch {
        /* */
      }
      resolve()
    }, wait)
  })
}

async function main() {
  console.log('########## ① 诊断 3a：host-node.cmd（.cmd → node.exe） ##########')
  await run({ label: '3a host-node.cmd', exe: 'cmd.exe', args: ['/c', CMD_NODE] })

  console.log('\n########## ② 对照：同一个 .cmd 形态，不经 cmd（直接 node） ##########')
  await run({
    label: '直接 node probe-host.cjs',
    exe: 'E:\\nodejs\\node.exe',
    args: ['E:\\CodexWorkbench\\harbor-edge\\exp\\probe-host.cjs'],
  })

  console.log('\n########## ③ 3b 对照：host-electron-node.cmd ##########')
  await run({ label: '3b host-electron-node.cmd', exe: 'cmd.exe', args: ['/c', CMD_ELNODE] })

  console.log('\n########## ④ 补充候选开关（能否消掉 \\r\\n）##########')
  await run({
    label: '④-1 ELECTRON_ENABLE_LOGGING=0',
    exe: HARBOR,
    args: ['--parent-window=0'],
    env: { ELECTRON_ENABLE_LOGGING: '0' },
  })
  await run({
    label: '④-2 --enable-logging=file --log-file=…',
    exe: HARBOR,
    args: ['--parent-window=0', '--enable-logging=file', `--log-file=${LOGFILE}`],
  })
  await run({ label: '④-3 不写 stdin（基线复核）', exe: HARBOR, args: ['--parent-window=0'], send: false })
}

main().catch((e) => console.log('ERR', e.message))
