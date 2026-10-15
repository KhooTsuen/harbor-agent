/**
 * 实验 3（重跑）：`.cmd` 包装器能否当 native host？
 *
 * ★ 重跑原因：第一次 3a 失败、3b「通过」都不干净 —— 两个 .cmd 里写了中文注释，
 *   而 cmd 按 OEM 码页（GBK）读 .cmd，UTF-8 中文变乱码、被当命令执行。
 *   现在两个 .cmd 都是**纯 ASCII**，这才是可以下定论的形态。
 *
 * 3a：cmd → node.exe → native-host.cjs（需机器装 Node —— 仅作对照）
 * 3b：cmd → ELECTRON_RUN_AS_NODE + Harbor.exe → native-host.cjs（不需额外 Node）
 * 3c：3b 的**真实部署形态** —— .cmd 与 Harbor.exe 同目录，路径全相对
 */

const path = require('node:path')
const { runHostCase, HOSTS } = require('./lib/driver.cjs')

const BASE = path.resolve(__dirname)
const HARBOR_DIR = 'E:\\CodexWorkbench\\dist-portable\\Harbor'
const ORIGIN = 'chrome-extension://chmojfjfoolkplcjdgcccjhanfglikpm/'

async function main() {
  console.log('═══ 实验 3（重跑，.cmd 已改纯 ASCII）═══')

  const a = await runHostCase({
    hostName: HOSTS[2],
    hostPath: path.join(BASE, 'host-node.cmd'),
    origin: ORIGIN,
    port: 9463,
    profileName: 'profile-exp3-a2',
    waitMs: 14000,
  })
  console.log(`\n── 3a .cmd → node.exe → native-host.cjs  →  ${a.ok ? '✅ 通过' : '❌ 不通过'} ──`)
  console.log(`   扩展上报 = ${JSON.stringify(a.reports)}`)

  const b = await runHostCase({
    hostName: HOSTS[2],
    hostPath: path.join(BASE, 'host-electron-node.cmd'),
    origin: ORIGIN,
    port: 9464,
    profileName: 'profile-exp3-b2',
    waitMs: 14000,
  })
  console.log(`\n── 3b .cmd → RUN_AS_NODE + Harbor.exe  →  ${b.ok ? '✅ 通过' : '❌ 不通过'} ──`)
  console.log(`   扩展上报 = ${JSON.stringify(b.reports)}`)

  const c = await runHostCase({
    hostName: HOSTS[2],
    hostPath: path.join(HARBOR_DIR, 'harbor-host.cmd'),
    origin: ORIGIN,
    port: 9466,
    profileName: 'profile-exp3-c',
    waitMs: 14000,
  })
  console.log(`\n── 3c 真实部署形态（.cmd 与 exe 同目录） →  ${c.ok ? '✅ 通过' : '❌ 不通过'} ──`)
  console.log(`   扩展上报 = ${JSON.stringify(c.reports)}`)

  console.log('\n═══ 实验 3 汇总（纯 ASCII 版）═══')
  console.log(`  3a（cmd + 机器自带 node） : ${a.ok ? '通过' : '不通过'}`)
  console.log(`  3b（cmd + 自带 Electron）  : ${b.ok ? '通过' : '不通过'}`)
  console.log(`  3c（同目录部署形态）        : ${c.ok ? '通过' : '不通过'}`)
}

main().catch((e) => {
  console.log('ERR', e.message)
  process.exit(1)
})
