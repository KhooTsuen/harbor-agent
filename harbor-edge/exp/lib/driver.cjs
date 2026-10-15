/**
 * 三组实验共用的 Edge 驱动。
 *
 * 隔离口径（用户要求）：每例都用**独立注册表键**（com.harbor.exp1/2/3，绝不用生产键
 * com.harbor.agent）+ 独立 profile（harbor-edge/exp/profiles/*）；跑完删注册表、退进程。
 * 不碰用户正在用的 Edge 实例 —— 这里总是新起一个带 --user-data-dir 的独立实例。
 *
 * 判据来源：探针扩展自己在启动时连 host 并把结果 POST 到本地报告服务器。
 * 所以「有没有收到 pong」看的是扩展真实收到的消息，不是我们的推测。
 */

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = path.resolve(__dirname, '..')
const EXT_DIR = path.join(BASE, 'ext')
const REPORT_PORT = 8792
const HOSTS = ['com.harbor.exp1', 'com.harbor.exp2', 'com.harbor.exp3']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function writeManifest(file, { name, hostPath, origins }) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify(
      { name, description: 'Harbor exp probe', path: hostPath, type: 'stdio', allowed_origins: origins },
      null,
      2,
    ),
  )
  return file
}

const keyOf = (name) => `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${name}`

function regAdd(name, manifestPath) {
  return spawnSync('reg', ['ADD', keyOf(name), '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f', '/reg:64'], {
    encoding: 'utf8',
  })
}

function regDel(name) {
  spawnSync('reg', ['DELETE', keyOf(name), '/f', '/reg:64'], { encoding: 'utf8' })
  spawnSync('reg', ['DELETE', keyOf(name), '/f', '/reg:32'], { encoding: 'utf8' })
}

/** 收扩展上报的本地服务器（固定 8792；实验串行跑，不冲突） */
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

async function launchEdge({ profileName, port, env = {} }) {
  const profile = path.join(BASE, 'profiles', profileName)
  fs.mkdirSync(profile, { recursive: true })
  const child = spawn(
    EDGE,
    [
      `--user-data-dir=${profile}`,
      `--load-extension=${EXT_DIR}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore', env: { ...process.env, ...env } },
  )
  let ready = false
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`)
      ready = true
      break
    } catch {
      await sleep(500)
    }
  }
  await sleep(4000)
  return { child, profile, ready }
}

function killEdge(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

/**
 * 跑一个 host 形态：写清单 → 注册 → 起 Edge → 等扩展上报 → 清理。
 * @returns {Promise<{ok:boolean, pong:object|null, reports:object[]}>}
 */
async function runHostCase({ hostName, hostPath, origin, env = {}, port, profileName, waitMs = 12000 }) {
  const manifest = path.join(BASE, 'manifests', `${hostName}.json`)
  writeManifest(manifest, { name: hostName, hostPath, origins: [origin] })
  regAdd(hostName, manifest)

  const report = startReportServer()
  let child = null
  try {
    const edge = await launchEdge({ profileName, port, env })
    child = edge.child
    if (!edge.ready) console.log('  ⚠ Edge CDP 未就绪')

    const t0 = Date.now()
    let pong = null
    while (Date.now() - t0 < waitMs) {
      await sleep(500)
      for (const r of report.reports) {
        if (r.host === hostName && r.stage === 'message' && r.msg && r.msg.pong) pong = r.msg
      }
      if (pong) break
    }
    return { ok: Boolean(pong), pong, reports: report.reports.filter((r) => r.host === hostName) }
  } finally {
    if (child) killEdge(child.pid)
    regDel(hostName)
    await report.close()
  }
}

module.exports = {
  EDGE,
  BASE,
  EXT_DIR,
  REPORT_PORT,
  HOSTS,
  sleep,
  writeManifest,
  regAdd,
  regDel,
  startReportServer,
  launchEdge,
  killEdge,
  runHostCase,
}
