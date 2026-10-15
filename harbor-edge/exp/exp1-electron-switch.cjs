/**
 * 实验 1：Electron / Chromium 命令行开关能否让 Harbor.exe（GUI 子系统）的 stdout
 * 通到 native messaging 管道？
 *
 * 背景（Phase 1a 实测）：Edge 拉起 Harbor.exe 时，host **读得到** ping（fd 0 有数据），
 * 但 fs.writeSync(1, frame) 返回 51（报"成功"）、Edge 一个字节收不到。
 *
 * 本实验分两条路：
 *   本地 spawn —— 直接把 Harbor.exe 的 stdio 接成我们的管道，不依赖 Edge。
 *                 这是**快判据**：能区分「GUI 子系统本身就写不出管道」与「Edge 场景特有」。
 *   经 Edge   —— 真实场景，用探针扩展连 host。
 *
 * 变体：
 *   A 本地 spawn          （基线）
 *   B 本地 + ELECTRON_NO_ATTACH_CONSOLE=1
 *   C 本地 + --no-stdio-init
 *   D 经 Edge             （基线）
 *   E 经 Edge + ELECTRON_NO_ATTACH_CONSOLE=1
 */

const { spawn } = require('node:child_process')
const { runHostCase, HOSTS } = require('./lib/driver.cjs')

const HARBOR = 'E:\\CodexWorkbench\\dist-portable\\Harbor\\Harbor.exe'
const ORIGIN = 'chrome-extension://chmojfjfoolkplcjdgcccjhanfglikpm/'

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

function decode(buf) {
  const msgs = []
  let off = 0
  while (buf.length - off >= 4) {
    const len = buf.readUInt32LE(off)
    if (len > 1024 * 1024) {
      msgs.push({ __err: `帧长离谱 ${len}` })
      break
    }
    if (buf.length - off - 4 < len) break
    const text = buf.subarray(off + 4, off + 4 + len).toString('utf8')
    try {
      msgs.push(JSON.parse(text))
    } catch {
      msgs.push({ __raw: text })
    }
    off += 4 + len
  }
  return msgs
}

/** 本地 spawn Harbor.exe 当 host，喂一帧，看 stdout 有没有回帧 */
function localSpawn({ args, env, label }) {
  return new Promise((resolve) => {
    const child = spawn(HARBOR, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let out = Buffer.alloc(0)
    let err = ''
    child.stdout.on('data', (c) => {
      out = Buffer.concat([out, c])
    })
    child.stderr.on('data', (c) => {
      err += c.toString()
    })
    child.on('error', (e) => resolve({ label, spawnError: e.message }))

    try {
      child.stdin.write(frame({ ping: 1 }))
    } catch (e) {
      resolve({ label, writeError: e.message })
      return
    }

    setTimeout(() => {
      const msgs = decode(out)
      const pong = msgs.find((m) => m && m.pong)
      resolve({
        label,
        ok: Boolean(pong),
        gotBytes: out.length,
        msgs,
        stderrHead: err.replace(/\s+/g, ' ').slice(0, 300),
      })
      try {
        child.kill()
      } catch {
        /* */
      }
    }, 3000)
  })
}

function show(r) {
  const tag = r.ok ? '✅ 通过' : '❌ 不通过'
  console.log(`\n── ${r.label} → ${tag} ──`)
  console.log(`   stdout 收到字节 = ${r.gotBytes ?? '(n/a)'}  解出消息 = ${JSON.stringify(r.msgs ?? [])}`)
  if (r.stderrHead) console.log(`   stderr = ${r.stderrHead}`)
  if (r.spawnError) console.log(`   spawn 错误 = ${r.spawnError}`)
}

async function main() {
  console.log('═══ 实验 1：Electron/Chromium 开关 vs Harbor.exe stdout 连通性 ═══')
  console.log(`Harbor.exe = ${HARBOR}`)
  console.log(`扩展 ID    = chmojfjfoolkplcjdgcccjhanfglikpm`)

  console.log('\n──── 本地 spawn（快判据）────')
  show(await localSpawn({ args: ['--parent-window=0'], env: {}, label: 'A 本地 spawn 基线' }))
  show(
    await localSpawn({
      args: ['--parent-window=0'],
      env: { ELECTRON_NO_ATTACH_CONSOLE: '1' },
      label: 'B 本地 + ELECTRON_NO_ATTACH_CONSOLE=1',
    }),
  )
  show(
    await localSpawn({
      args: ['--parent-window=0', '--no-stdio-init'],
      env: {},
      label: 'C 本地 + --no-stdio-init',
    }),
  )

  console.log('\n──── 经真实 Edge（关键判据）────')
  const D = await runHostCase({
    hostName: HOSTS[0],
    hostPath: HARBOR,
    origin: ORIGIN,
    env: {},
    port: 9461,
    profileName: 'profile-exp1-d',
    waitMs: 14000,
  })
  console.log(`\n── D 经 Edge 基线（Harbor.exe 零参数）→ ${D.ok ? '✅ 通过' : '❌ 不通过'} ──`)
  console.log(`   扩展上报（该 host）= ${JSON.stringify(D.reports)}`)

  const E = await runHostCase({
    hostName: HOSTS[1],
    hostPath: HARBOR,
    origin: ORIGIN,
    env: { ELECTRON_NO_ATTACH_CONSOLE: '1' },
    port: 9462,
    profileName: 'profile-exp1-e',
    waitMs: 14000,
  })
  console.log(`\n── E 经 Edge + ELECTRON_NO_ATTACH_CONSOLE=1 → ${E.ok ? '✅ 通过' : '❌ 不通过'} ──`)
  console.log(`   扩展上报（该 host）= ${JSON.stringify(E.reports)}`)

  console.log('\n═══ 实验 1 汇总 ═══')
  console.log(`  A 本地基线                : ${'(见上)'}`)
  console.log(`  D 经 Edge 基线            : ${D.ok ? '通过' : '不通过'}`)
  console.log(`  E 经 Edge + NO_ATTACH     : ${E.ok ? '通过' : '不通过'}`)
}

main().catch((e) => {
  console.log('ERR', e.message)
  process.exit(1)
})
