/**
 * Phase 0 · 步骤 D：矩阵实验 —— 找出「Edge 到底认哪一种注册表/清单配置」。
 *
 * 上一轮拿到确切错误：`Specified native messaging host not found.`
 * → 是**注册表/清单层**没被认到（不是 path 参数问题；若是参数问题，
 *   报的会是 "Failed to start native messaging host"，且 origin 不对会报 "forbidden"）。
 *
 * 怀疑点：Edge 装在 `Program Files (x86)`，而 `reg ADD` 默认写 **64 位视图**。
 * 文档说 Edge「先查 32 位视图，再查 64 位视图」—— 那就两边都写，逐个组合试。
 *
 * 每个组合：写注册表 → 起 Edge → CDP 调 connectNative → 记录 lastError → 清注册表。
 */
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const NODE = 'E:\\nodejs\\node.exe'
const BASE = 'E:\\CodexWorkbench\\harbor-edge\\phase0'
const EXT = path.join(BASE, 'ext')
const HOST_SCRIPT = path.join(BASE, 'probe-host.js')
const MANIFEST = path.join(BASE, 'com.harbor.phase0.probe.json')
const HOST_LOG = path.join(BASE, 'host-report.json')
const HOST_NAME = 'com.harbor.phase0.probe'
const EXT_ID = 'fgiopdanmkafnmpcjiiofkbbgikmdljn'
const KEY = `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function writeManifest(hostPath) {
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
}

function regAdd(view) {
  const args = ['ADD', KEY, '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f']
  if (view === '32') args.push('/reg:32')
  if (view === '64') args.push('/reg:64')
  const r = spawnSync('reg', args, { encoding: 'utf8' })
  return r.status === 0
}
function regDel(view) {
  const args = ['DELETE', KEY, '/f']
  if (view === '32') args.push('/reg:32')
  if (view === '64') args.push('/reg:64')
  spawnSync('reg', args, { encoding: 'utf8' })
}

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
    ws.addEventListener('error', () => reject(new Error('ws error')))
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
            reject(new Error(`CDP 超时 ${method}`))
          }
        }, 12000)
      })
    },
  }
}

const EVAL = (hostName) => `
(async () => {
  const out = {};
  try {
    const port = chrome.runtime.connectNative(${JSON.stringify(hostName)});
    const r = await new Promise((resolve) => {
      let done = false;
      port.onMessage.addListener((m) => { if (!done) { done = true; resolve({ ok: true, message: m }); } });
      port.onDisconnect.addListener(() => {
        if (done) return; done = true;
        resolve({ ok: false, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
      });
      try { port.postMessage({ ping: 1 }); } catch (e) { out.postErr = String(e && e.message); }
      setTimeout(() => { if (!done) { done = true; resolve({ ok: false, timeout: true }); } }, 6000);
    });
    out.result = r;
  } catch (e) { out.threw = String(e && e.message); }
  return JSON.stringify(out);
})()
`

/** 跑一个组合：起 Edge、连 SW、调 connectNative、返回结果 */
async function trial(label, { view, hostPath, port }) {
  console.log(`\n──────── ${label} ────────`)
  writeManifest(hostPath)
  regDel('32')
  regDel('64')
  const added = regAdd(view)
  console.log(`  注册表视图=${view} 写入=${added ? 'ok' : '失败'}  path=${hostPath}`)
  try {
    fs.unlinkSync(HOST_LOG)
  } catch {
    /* */
  }

  const profile = path.join(BASE, `edge-trial-${port}`)
  fs.mkdirSync(profile, { recursive: true })
  const child = spawn(
    EDGE,
    [
      `--user-data-dir=${profile}`,
      `--load-extension=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  )

  let verdict = '（未测到）'
  try {
    for (let i = 0; i < 30; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`)
        break
      } catch {
        await sleep(500)
      }
    }
    await sleep(3500)
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const sw = targets.find((t) => t.type === 'service_worker' && String(t.url).includes(EXT_ID))
    if (!sw) {
      verdict = '✗ 没找到扩展 SW'
    } else {
      const cdp = connect(sw.webSocketDebuggerUrl)
      await cdp.ready
      await cdp.send('Runtime.enable')
      const r = await cdp.send('Runtime.evaluate', {
        expression: EVAL(HOST_NAME),
        awaitPromise: true,
        returnByValue: true,
      })
      verdict = r?.result?.value ?? JSON.stringify(r)
      cdp.ws.close()
    }
  } catch (e) {
    verdict = '✗ 异常：' + e.message
  } finally {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    regDel('32')
    regDel('64')
    await sleep(600)
  }

  const hostWrote = fs.existsSync(HOST_LOG)
  console.log(`  connectNative 结果 = ${verdict}`)
  console.log(`  host 是否被拉起 = ${hostWrote ? '★ 是' : '否'}`)
  if (hostWrote) {
    const entries = JSON.parse(fs.readFileSync(HOST_LOG, 'utf8'))
    const started = entries.find((e) => e.stage === 'started')
    if (started) console.log(`  argv = ${JSON.stringify(started.argv)}  markerSeen=${started.markerSeen}`)
    const got = entries.find((e) => e.stage === 'got-message')
    if (got) console.log(`  收到消息 = ${JSON.stringify(got.message)}`)
  }
  return { label, verdict, hostWrote }
}

async function main() {
  const results = []
  /* 组合 1：64 位视图 + 纯 exe（最朴素的形态） */
  results.push(
    await trial('A) 64位视图 + path=node.exe', { view: '64', hostPath: NODE, port: 9421 }),
  )
  /* 组合 2：32 位视图 + 纯 exe */
  results.push(
    await trial('B) 32位视图 + path=node.exe', { view: '32', hostPath: NODE, port: 9422 }),
  )
  /* 组合 3：32 位视图 + exe+脚本（Node 无参数会进 REPL，这里验证注册表视图是否是瓶颈） */
  results.push(
    await trial('C) 32位视图 + path=node.exe+脚本', {
      view: '32',
      hostPath: `${NODE} "${HOST_SCRIPT}"`,
      port: 9423,
    }),
  )
  /* 组合 4：64 位视图 + exe+脚本 */
  results.push(
    await trial('D) 64位视图 + path=node.exe+脚本', {
      view: '64',
      hostPath: `${NODE} "${HOST_SCRIPT}"`,
      port: 9424,
    }),
  )

  console.log('\n\n════════ 汇总 ════════')
  for (const r of results) {
    console.log(`  ${r.hostWrote ? '★拉起' : '  未起'}  ${r.label}`)
    console.log(`         ${String(r.verdict).slice(0, 160)}`)
  }
}

main().catch((e) => console.log('ERR', e.message))
