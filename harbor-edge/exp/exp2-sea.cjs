/**
 * 实验 2：Node 24 SEA 打包出来的 exe，PE 子系统是什么？协议能不能通？
 *
 * 步骤：生成 blob → 复制 node.exe → postject 注入 → 读 PE 子系统 → 经 Edge 测协议。
 *
 * 为什么这条路重要：SEA 产物 = **node.exe 副本 + 注入资源段**，如果 PE 子系统仍是
 * CONSOLE(3)，那我们就能「随包发一个 SEA host exe」，不需要 C 编译器（这正是不批方案 A 的原因）。
 *
 * ⚠️ v24 没有 `--build-sea`（那是 v26），所以注入步骤必须用 postject（npm 包，
 *    **构建期临时工具**，按用户红线在报告里列出）。
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { peSubsystem } = require('./lib/pe.cjs')
const { runHostCase, HOSTS } = require('./lib/driver.cjs')

const NODE = 'E:\\nodejs\\node.exe'
const SEA = path.join(__dirname, 'sea')
const BLOB = path.join(SEA, 'sea-prep.blob')
const EXE = path.join(SEA, 'host-sea.exe')
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
const ORIGIN = 'chrome-extension://chmojfjfoolkplcjdgcccjhanfglikpm/'

function line(...a) {
  console.log(...a)
}

async function main() {
  line('═══ 实验 2：Node 24 SEA 打包 ═══')

  fs.mkdirSync(SEA, { recursive: true })

  line('\n── 步骤 1：生成 SEA blob ──')
  const r1 = spawnSync(NODE, ['--experimental-sea-config', path.join(SEA, 'sea-config.json')], {
    encoding: 'utf8',
    cwd: SEA,
  })
  line(`  rc=${r1.status}`)
  if (r1.stderr) line(`  stderr=${r1.stderr.slice(0, 400)}`)
  const blobOk = fs.existsSync(BLOB)
  line(`  blob 存在=${blobOk} 大小=${blobOk ? fs.statSync(BLOB).size : 0}`)

  line('\n── 步骤 2：复制 node.exe ──')
  fs.copyFileSync(NODE, EXE)
  line(`  已复制 → ${EXE}`)
  line(`  复制后 PE 子系统 = ${JSON.stringify(peSubsystem(EXE))}`)

  line('\n── 步骤 3：postject 注入 blob（构建期工具，需报备）──')
  const r3 = spawnSync(
    'npx',
    ['--yes', 'postject', EXE, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', SENTINEL],
    { encoding: 'utf8', shell: true, timeout: 240000 },
  )
  line(`  rc=${r3.status}`)
  line(`  stdout=${(r3.stdout || '').slice(-300)}`)
  line(`  stderr=${(r3.stderr || '').slice(-300)}`)

  line('\n── 步骤 4：读注入后的 PE 子系统（★ 核心判据）──')
  const pe = peSubsystem(EXE)
  line(`  ${JSON.stringify(pe)}`)
  const consoleSub = pe.subsystem === 3
  line(`  ★ 是 CONSOLE(3) 吗 = ${consoleSub ? '是' : '否'}`)

  line('\n── 步骤 5：经真实 Edge 测协议 ──')
  let edgeOk = false
  if (fs.existsSync(EXE)) {
    const c = await runHostCase({
      hostName: HOSTS[0],
      hostPath: EXE,
      origin: ORIGIN,
      port: 9465,
      profileName: 'profile-exp2',
      waitMs: 16000,
    })
    edgeOk = c.ok
    line(`  ★ 经 Edge 协议 = ${c.ok ? '✅ 通过' : '❌ 不通过'}`)
    line(`  扩展上报 = ${JSON.stringify(c.reports)}`)
  }

  line('\n═══ 实验 2 汇总 ═══')
  line(`  SEA exe 的 PE 子系统 = ${pe.label}  →  ${consoleSub ? '✅ 是 CONSOLE（可用）' : '❌ 不是 CONSOLE'}`)
  line(`  经 Edge 协议跑通     = ${edgeOk ? '✅ 通过' : '❌ 不通过'}`)
}

main().catch((e) => {
  console.log('ERR', e.message)
  process.exit(1)
})
