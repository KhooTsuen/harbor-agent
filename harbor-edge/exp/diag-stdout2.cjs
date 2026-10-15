/**
 * 诊断 2：那个 `\r\n` 从哪来？
 *
 * 已知（diag-stdout）：
 *   node.exe  当 host → stdout = `1c000000{...}`          ← 纯帧
 *   Harbor.exe 当 host → stdout = `0d0a` + `1c000000{...}` ← 帧前多了 CRLF
 *
 * 要分清两件事：
 *   ① `\r\n` 是**进程启动时**写的（Chromium/Electron 初始化），还是**读 stdin 触发**的？
 *   ② `ELECTRON_RUN_AS_NODE=1`（绕开 Chromium）时，stdout 干不干净？
 *
 * 判据：不写 stdin 也出现 `\r\n` ⇒ 是启动噪音。
 */

const { spawn } = require('node:child_process')

const HARBOR = 'E:\\CodexWorkbench\\dist-portable\\Harbor\\Harbor.exe'
const NATIVE_HOST =
  'E:\\CodexWorkbench\\dist-portable\\Harbor\\resources\\app\\electron\\native-host.cjs'

function frame(obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8')
  const h = Buffer.alloc(4)
  h.writeUInt32LE(b.length, 0)
  return Buffer.concat([h, b])
}

function run({ label, args, env = {}, writeStdin }) {
  return new Promise((resolve) => {
    const child = spawn(HARBOR, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    const out = []
    const err = []
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.on('error', (e) => resolve({ label, spawnError: e.message }))
    if (writeStdin) child.stdin.write(frame({ ping: 1 }))

    setTimeout(() => {
      const o = Buffer.concat(out)
      const e = Buffer.concat(err)
      console.log(`\n══ ${label} ══`)
      console.log(`  STDOUT len=${o.length}  hex=${o.toString('hex')}`)
      console.log(`  STDOUT repr=${JSON.stringify(o.toString('latin1'))}`)
      console.log(`  STDERR=${JSON.stringify(e.toString('utf8').replace(/\s+/g, ' ').slice(0, 200))}`)
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
  await run({ label: '① Harbor host · 不写 stdin（纯读 stdout）', args: ['--parent-window=0'], writeStdin: false })
  await run({ label: '② Harbor host · 写 stdin', args: ['--parent-window=0'], writeStdin: true })
  await run({
    label: '③ Harbor + ELECTRON_NO_ATTACH_CONSOLE · 写 stdin',
    args: ['--parent-window=0'],
    env: { ELECTRON_NO_ATTACH_CONSOLE: '1' },
    writeStdin: true,
  })
  await run({
    label: '④ ELECTRON_RUN_AS_NODE + native-host.cjs · 不写 stdin',
    args: [NATIVE_HOST],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    writeStdin: false,
  })
  await run({
    label: '⑤ ELECTRON_RUN_AS_NODE + native-host.cjs · 写 stdin',
    args: [NATIVE_HOST],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    writeStdin: true,
  })
}

main().catch((e) => console.log('ERR', e.message))
