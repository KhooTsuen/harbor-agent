/**
 * Phase 0 · 步骤 C：CDP 直连扩展的 Service Worker，手动调 connectNative 拿真实错误。
 *
 * 为什么要这样：host 没被拉起来时，光看「没日志」区分不出是
 *   ① 扩展 SW 压根没跑 ② connectNative 抛错 ③ 清单/注册表没被 Edge 认到 ④ host 启动失败
 * 直接进 SW 上下文调一次，`chrome.runtime.lastError` 会把话说清楚。
 *
 * 用 Node 内置 WebSocket（22+ 有，本机 24），零依赖。
 */
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'E:\\CodexWorkbench\\harbor-edge\\phase0'
const PROFILE = path.join(BASE, 'edge-profile4')
const EXT = path.join(BASE, 'ext')
const PORT = 9414
const HOST_NAME = 'com.harbor.phase0.probe'
const EXT_ID = 'fgiopdanmkafnmpcjiiofkbbgikmdljn'
const HOST_SCRIPT = path.join(BASE, 'probe-host.js')
const MANIFEST = path.join(BASE, 'com.harbor.phase0.probe.json')
const HOST_LOG = path.join(BASE, 'host-report.json')
const REG_KEY = `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 注册表：本机原本没有 Edge 的 NativeMessagingHosts 键，这里建、收尾删 ── */
function setupHost(mode) {
  const NODE = 'E:\\nodejs\\node.exe'
  const hostPath =
    mode === 'args'
      ? `${NODE} ${HOST_SCRIPT} --harbor-marker=PHASE0`
      : mode === 'script'
        ? `${NODE} ${HOST_SCRIPT}`
        : NODE
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: 'Harbor Phase 0 native messaging probe',
        path: hostPath,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${EXT_ID}/`],
      },
      null,
      2,
    ),
  )
  spawnSync('reg', ['ADD', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f'], { encoding: 'utf8' })
  console.log(`host 清单 path = ${hostPath}`)
}
function teardownHost() {
  spawnSync('reg', ['DELETE', REG_KEY, '/f'], { encoding: 'utf8' })
}

/* ── 极简 CDP ── */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (e) => reject(new Error('ws error ' + (e.message || ''))))
  })
  return {
    ws,
    ready,
    send(method, params) {
      const myId = ++id
      return new Promise((resolve, reject) => {
        pending.set(myId, { resolve, reject })
        ws.send(JSON.stringify({ id: myId, method, params }))
        setTimeout(() => {
          if (pending.has(myId)) {
            pending.delete(myId)
            reject(new Error(`CDP 超时：${method}`))
          }
        }, 15000)
      })
    },
  }
}

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

const EVAL = `
(async () => {
  const out = { step: 'start' };
  try {
    out.hasConnectNative = typeof chrome?.runtime?.connectNative;
    out.manifest = chrome.runtime.getManifest();
  } catch (e) { out.manifestErr = String(e && e.message); }
  try {
    const port = await new Promise((resolve, reject) => {
      let p;
      try { p = chrome.runtime.connectNative('${HOST_NAME}'); }
      catch (e) { reject(e); return; }
      resolve(p);
    });
    out.connected = true;
    const result = await new Promise((resolve) => {
      let done = false;
      port.onMessage.addListener((m) => { if (!done) { done = true; resolve({ ok: true, message: m }); } });
      port.onDisconnect.addListener(() => {
        if (done) return;
        done = true;
        resolve({ ok: false, disconnect: true, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
      });
      try { port.postMessage({ ping: 1 }); } catch (e) { out.postErr = String(e && e.message); }
      setTimeout(() => { if (!done) { done = true; resolve({ ok: false, timeout: true }); } }, 6000);
    });
    out.result = result;
  } catch (e) {
    out.connectThrew = String(e && e.message);
  }
  return JSON.stringify(out);
})()
`

async function main() {
  const mode = process.argv.includes('--no-args') ? 'node' : process.argv.includes('--script') ? 'script' : 'args'
  console.log(`模式 = ${mode}\n`)
  setupHost(mode)
  try { fs.unlinkSync(HOST_LOG) } catch { /* */ }

  fs.mkdirSync(PROFILE, { recursive: true })
  const child = spawn(
    EDGE,
    [
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--remote-debugging-port=${PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  )
  console.log(`Edge PID=${child.pid}`)

  try {
    /* 等 devtools 端口 */
    for (let i = 0; i < 30; i++) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/json/version`)
        break
      } catch {
        await sleep(500)
      }
    }
    await sleep(4000)

    const targets = await listTargets()
    console.log(`\n=== targets（${targets.length}）===`)
    for (const t of targets) console.log(`  [${t.type}] ${String(t.url).slice(0, 100)}`)

    /* ★ 按扩展 ID 匹配 —— URL 是 chrome-extension://<ID>/service-worker.js，
       里面**没有**目录名（第一版按 'harbor-edge' 匹配，于是明明在也找不到）。 */
    const swTarget = targets.find(
      (t) => t.type === 'service_worker' && String(t.url).includes(EXT_ID),
    )
    if (!swTarget) {
      console.log('\n✗ 没找到我们扩展的 service_worker target')
      const anySW = targets.filter((t) => t.type === 'service_worker')
      console.log(`  （service_worker 类型的 target 共 ${anySW.length} 个）`)
    } else {
      console.log(`\n=== 连上 SW 并手动 connectNative ===`)
      const cdp = connect(swTarget.webSocketDebuggerUrl)
      await cdp.ready
      await cdp.send('Runtime.enable')
      const r = await cdp.send('Runtime.evaluate', {
        expression: EVAL,
        awaitPromise: true,
        returnByValue: true,
      })
      console.log('  结果 =', r?.result?.value ?? JSON.stringify(r))
      cdp.ws.close()
    }

    await sleep(1500)
    if (fs.existsSync(HOST_LOG)) {
      console.log('\n=== host 侧记录 ===')
      console.log(fs.readFileSync(HOST_LOG, 'utf8'))
    } else {
      console.log('\n（host 一个字节都没写）')
    }
  } finally {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    teardownHost()
    console.log('\n已收尾（Edge 关闭、注册表已删）')
  }
}

main().catch((e) => console.log('ERR', e.message))
