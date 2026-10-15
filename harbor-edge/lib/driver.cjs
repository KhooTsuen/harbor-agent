/**
 * Phase 1b 共用的 Edge 驱动（从 harbor-edge/exp/lib/driver.cjs 精简而来）。
 *
 * 隔离口径（沿用三组实验的规矩）：**总是**新起一个带 `--user-data-dir` 的独立
 * Edge 实例，绝不去碰用户正在用的那个；注册表只用调用方指定的键名；跑完退进程。
 *
 * 判据来源有两条，互不依赖：
 *   ① 探针扩展自己把「收到什么」POST 到本地报告服务器（看的是扩展**真实**收到的消息）；
 *   ② 直接读 Edge profile 的 `Default/Secure Preferences` —— unpacked 扩展的 ID
 *      由**加载路径**决定，所以「加载一次读回来」是唯一可靠办法（算不出来，实测过）。
 */

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const BASE = path.resolve(__dirname, '..')
const EXT_DIR = path.join(BASE, 'ext')
const PROFILE_ROOT = path.join(BASE, 'profiles')
const REPORT_PORT = 8792

/** Edge 可执行文件：环境变量优先，其次常见安装位置（两种 Program Files 都试） */
function edgeExe() {
  if (process.env.HARBOR_EDGE_EXE) return process.env.HARBOR_EDGE_EXE
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
  const candidates = roots
    .map((r) => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    .concat(['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'])
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* 继续找 */
    }
  }
  return ''
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const keyOf = (name) => `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${name}`

/** 写注册表（同时写 64 / 32 位视图 —— 官方搜索顺序里两个都查） */
function regAdd(name, manifestPath) {
  const out = []
  for (const view of ['/reg:64', '/reg:32']) {
    out.push(spawnSync('reg', ['ADD', keyOf(name), '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f', view], { encoding: 'utf8' }))
  }
  return out
}

function regDel(name) {
  for (const view of ['/reg:64', '/reg:32']) {
    spawnSync('reg', ['DELETE', keyOf(name), '/f', view], { encoding: 'utf8' })
  }
}

/** 收扩展上报的本地服务器（扩展在 service-worker.js 里 POST 过来） */
function startReportServer(port = REPORT_PORT) {
  const reports = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      try {
        reports.push(JSON.parse(body))
      } catch {
        /* 不是 JSON 就丢 */
      }
      res.writeHead(204)
      res.end()
    })
  })
  server.listen(port, '127.0.0.1')
  return { reports, close: () => new Promise((r) => server.close(r)) }
}

/**
 * 起一个隔离 Edge 加载探针扩展。
 * @param {{ profileName: string, port: number, extDir?: string, waitMs?: number }} opts
 */
async function launchEdge(opts) {
  const exe = edgeExe()
  if (!exe) throw new Error('找不到 msedge.exe（可用 HARBOR_EDGE_EXE 指定）')
  const profile = path.join(PROFILE_ROOT, opts.profileName)
  fs.mkdirSync(profile, { recursive: true })
  const child = spawn(
    exe,
    [
      `--user-data-dir=${profile}`,
      `--load-extension=${opts.extDir ?? EXT_DIR}`,
      /* Chrome 137+ 起命令行 --load-extension 默认被关，要显式打开这个开关（Phase 0 实测） */
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--remote-debugging-port=${opts.port}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  let ready = false
  for (let i = 0; i < 40 && !ready; i++) {
    try {
      await fetch(`http://127.0.0.1:${opts.port}/json/version`)
      ready = true
    } catch {
      await sleep(500)
    }
  }
  await sleep(opts.waitMs ?? 4000)
  return { child, profile, ready, exe }
}

function killEdge(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

/**
 * 删掉一次探针跑出来的隔离 profile。
 *
 * ★ 为什么必须删：一个 Edge profile 实测 **15 MB**（首次加载扩展后还要更大）。
 *   安装脚本每跑一次读一次扩展 ID 就造一个 —— 不删的话「装一次留一个」，
 *   用户机器上会慢慢攒出几百 MB 的垃圾（三组实验阶段就攒了 11 个）。
 *
 * Edge 刚退出时文件可能还被占着，所以带重试；删不掉不算致命（记一行 stderr），
 * 绝不能因此让安装失败。
 */
function removeProfile(profile, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
      if (!fs.existsSync(profile)) return true
    } catch {
      /* 多半是还被占着，等一下再试 */
    }
    spawnSync('cmd', ['/c', 'ping', '-n', '2', '127.0.0.1'], { stdio: 'ignore' })
  }
  process.stderr.write(`[driver] 没删掉 profile：${profile}\n`)
  return false
}

/** 按加载路径从 profile 里读出扩展 ID（unpacked 扩展的 ID 由路径决定） */
function readExtIdFromProfile(profile, extDir = EXT_DIR) {
  const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase()
  const want = norm(extDir)
  const files = [path.join(profile, 'Default', 'Secure Preferences'), path.join(profile, 'Default', 'Preferences')]
  for (const file of files) {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'))
      const settings = json?.extensions?.settings ?? {}
      for (const [id, value] of Object.entries(settings)) {
        if (norm(value?.path ?? '') === want) return id
      }
    } catch {
      /* 文件不在 / 解析不了就试下一个 */
    }
  }
  return null
}

module.exports = {
  BASE,
  EXT_DIR,
  PROFILE_ROOT,
  REPORT_PORT,
  edgeExe,
  sleep,
  keyOf,
  regAdd,
  regDel,
  startReportServer,
  launchEdge,
  killEdge,
  removeProfile,
  readExtIdFromProfile,
}
