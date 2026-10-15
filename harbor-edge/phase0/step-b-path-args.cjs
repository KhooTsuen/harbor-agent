/**
 * Phase 0 · 步骤 B：点 1（path 能否带参数）+ 点 2（注册表键是否有效）实测。
 *
 * 做法：
 *   ① 生成 host 清单，`path` 写成「node.exe + 脚本 + --harbor-marker=PHASE0」——
 *      如果 Edge 把整串当路径，会找不到文件；如果它正确切分，marker 会进 argv。
 *   ② 写 HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\<name>（默认值 = 清单路径）
 *   ③ 起 Edge（加载扩展）→ 扩展自动 connectNative → 发 {"ping":1}
 *   ④ host 把真实 argv 落盘 → 读它
 *
 * 注意：本机 **原本没有** Edge 的 NativeMessagingHosts 键（已实测），
 * 所以这里建的是新键，用完脚本会自己删掉（除非传 --keep）。
 */
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const NODE = 'E:\\nodejs\\node.exe'
const BASE = 'E:\\CodexWorkbench\\harbor-edge\\phase0'
const PROFILE = path.join(BASE, 'edge-profile3')
const EXT = path.join(BASE, 'ext')
const HOST_SCRIPT = path.join(BASE, 'probe-host.js')
const MANIFEST = path.join(BASE, 'com.harbor.phase0.probe.json')
const HOST_LOG = path.join(BASE, 'host-report.json')
const HOST_NAME = 'com.harbor.phase0.probe'
const MARKER = '--harbor-marker=PHASE0'
const EXT_ID = 'fgiopdanmkafnmpcjiiofkbbgikmdljn' // 上一轮实测拿到的
const REG_KEY = `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`

const keep = process.argv.includes('--keep')
/** 传 --no-args 就测「path 不带参数」的对照形态 */
const withArgs = !process.argv.includes('--no-args')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function writeManifest() {
  /*
   * ★ 对照组必须是「能正常工作」的那一形态，否则失败时区分不出原因：
   *   对照组 = node.exe + 脚本（不带 marker）→ 跑通了说明链路本身是通的
   *   实验组 = node.exe + 脚本 + marker     → 跑通且 markerSeen 说明参数能带
   * （第一版对照组只写了 node.exe 不带脚本 —— node 无参数进 REPL，当然不写日志，
   *   那个形态根本证明不了任何事。）
   */
  const hostPath = withArgs ? `${NODE} ${HOST_SCRIPT} ${MARKER}` : `${NODE} ${HOST_SCRIPT}`
  const manifest = {
    name: HOST_NAME,
    description: 'Harbor Phase 0 native messaging probe',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXT_ID}/`],
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2))
  console.log(`=== host 清单已写 ===\n  path = ${hostPath}`)
  return hostPath
}

function addRegistry() {
  const r = spawnSync('reg', ['ADD', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f'], {
    encoding: 'utf8',
  })
  console.log(`=== 注册表写入（${REG_KEY}）rc=${r.status} ===`)
  const q = spawnSync('reg', ['query', REG_KEY, '/ve'], { encoding: 'utf8' })
  console.log(q.stdout.trim())
}

function delRegistry() {
  const r = spawnSync('reg', ['DELETE', REG_KEY, '/f'], { encoding: 'utf8' })
  console.log(`=== 注册表已删 rc=${r.status} ===`)
}

async function launchAndWait() {
  // 每次清掉旧日志，避免读到上一次的结果
  try {
    fs.unlinkSync(HOST_LOG)
  } catch {
    /* 本来就没有 */
  }
  try {
    fs.unlinkSync(path.join(BASE, 'ext-report.json'))
  } catch {
    /* 本来就没有 */
  }

  fs.mkdirSync(PROFILE, { recursive: true })
  const child = spawn(
    EDGE,
    [
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--remote-debugging-port=9413',
      '--enable-logging',
      '--log-level=1',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  )
  console.log(`\n=== Edge PID=${child.pid}，等扩展触发 connectNative（12 秒）===`)
  await sleep(12000)
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  console.log('已关闭探针 Edge 实例')

  /* Edge 自己的 native messaging 诊断（官方：--enable-logging --log-level=1，
     然后在 chrome_debug.log 里搜 launch_context / native_messag） */
  const dbg = path.join(PROFILE, 'chrome_debug.log')
  if (fs.existsSync(dbg)) {
    const hits = fs
      .readFileSync(dbg, 'utf8')
      .split('\n')
      .filter((l) => /native_messag|launch_context|NativeMessaging/i.test(l))
    console.log(`\n=== Edge 日志里的 native messaging 记录（${hits.length} 行）===`)
    for (const l of hits.slice(0, 25)) console.log('  ' + l.trim().slice(0, 220))
    if (hits.length === 0) {
      console.log('  （没有相关记录）')
      console.log(`  chrome_debug.log 总行数 = ${fs.readFileSync(dbg, 'utf8').split('\n').length}`)
    }
  } else {
    console.log('\n（没有 chrome_debug.log）')
  }
}

function readHostLog() {
  if (!fs.existsSync(HOST_LOG)) {
    console.log('\n✗ host 一个字节都没写 —— 说明它根本没被拉起来')
    return null
  }
  const entries = JSON.parse(fs.readFileSync(HOST_LOG, 'utf8'))
  console.log(`\n=== host 侧记录（${entries.length} 条）===`)
  console.log(JSON.stringify(entries, null, 2))
  return entries
}

function readExtLog() {
  const f = path.join(BASE, 'ext-report.json')
  if (!fs.existsSync(f)) {
    console.log('（扩展侧报告文件不存在 —— 它 fetch 不到探针服务器，属正常）')
    return
  }
  console.log('=== 扩展侧记录 ===')
  console.log(fs.readFileSync(f, 'utf8'))
}

async function main() {
  console.log(`模式：path ${withArgs ? '带参数' : '不带参数（对照组）'}\n`)
  const hostPath = writeManifest()
  addRegistry()
  await launchAndWait()
  const entries = readHostLog()
  readExtLog()

  console.log('\n══════ 结论 ══════')
  if (!entries) {
    console.log('✗ host 未被拉起来 —— 这一形态不通过')
  } else {
    const started = entries.find((e) => e.stage === 'started')
    console.log(`  收到启动记录：${started ? '是' : '否'}`)
    if (started) {
      console.log(`  argv = ${JSON.stringify(started.argv)}`)
      console.log(`  ★ markerSeen = ${started.markerSeen}`)
      console.log(`  cwd = ${started.cwd}`)
    }
    const got = entries.find((e) => e.stage === 'got-message')
    console.log(`  ★ 收到扩展消息 = ${got ? JSON.stringify(got.message) : '没收到'}`)
  }

  if (!keep) {
    delRegistry()
  } else {
    console.log(`\n（--keep：注册表保留，键 = ${REG_KEY}）`)
    console.log(`（测试完请删：reg delete "${REG_KEY}" /f）`)
  }
}

main().catch((e) => console.log('ERR', e.message))
