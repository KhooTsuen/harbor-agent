/**
 * Phase 0 · 步骤 E：验证「纯 exe 作为 host」这条替代路径 ——
 *    并抓 Edge 拉起 host 时**真实传的 argv**。
 *
 * 原理：A 组已证明 `path=node.exe`（纯 exe）时 **host 会被成功启动**。
 * 那只要让 node.exe 一启动就执行我的脚本就行 —— 用 `NODE_OPTIONS=--require <脚本>`，
 * 环境变量**会被 Edge 的子进程继承**（native messaging 不清理环境变量）。
 *
 * 判据：
 *   ① host 侧记录里有没有 argv[1] = chrome-extension://…（文档说第一个参数是 origin）
 *   ② 有没有 --parent-window=
 *   ③ 协议能否跑通（发 {"ping":1} → 回 {"pong":1}）
 *
 * ★ 这个形态正好就是 Harbor 最终要走的路：path 只写 Harbor.exe，
 *   由 Harbor.exe 自己看 argv 决定「我是被 Edge 拉起的」。零参数、零包装脚本。
 */
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const NODE = 'E:\\nodejs\\node.exe'
const BASE = 'E:\\CodexWorkbench\\harbor-edge\\phase0'
const EXT = path.join(BASE, 'ext')
const HOST_SCRIPT = path.join(BASE, 'probe-host.cjs')
const MANIFEST = path.join(BASE, 'com.harbor.phase0.probe.json')
const HOST_LOG = path.join(BASE, 'host-report.json')
const HOST_NAME = 'com.harbor.phase0.probe'
const EXT_ID = 'fgiopdanmkafnmpcjiiofkbbgikmdljn'
const KEY = `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`
const PORT = 9431

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

const EVAL = `
(async () => {
  const out = {};
  const port = chrome.runtime.connectNative(${JSON.stringify(HOST_NAME)});
  const r = await new Promise((resolve) => {
    let done = false;
    port.onMessage.addListener((m) => { if (!done) { done = true; resolve({ ok: true, gotPong: m && m.pong === 1, message: m }); } });
    port.onDisconnect.addListener(() => {
      if (done) return; done = true;
      resolve({ ok: false, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
    });
    try { port.postMessage({ ping: 1 }); } catch (e) { out.postErr = String(e && e.message); }
    setTimeout(() => { if (!done) { done = true; resolve({ ok: false, timeout: true }); } }, 8000);
  });
  out.result = r;
  return JSON.stringify(out);
})()
`

async function main() {
  console.log('=== 形态：path = 纯 node.exe（无参数），靠 NODE_OPTIONS 让 node 执行探针脚本 ===\n')
  writeManifest(NODE)
  spawnSync('reg', ['ADD', KEY, '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f', '/reg:64'], {
    encoding: 'utf8',
  })
  console.log(`注册表（64位视图）→ ${MANIFEST}`)
  try {
    fs.unlinkSync(HOST_LOG)
  } catch {
    /* */
  }

  const profile = path.join(BASE, 'edge-trial-e')
  fs.mkdirSync(profile, { recursive: true })

  const child = spawn(
    EDGE,
    [
      `--user-data-dir=${profile}`,
      `--load-extension=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--remote-debugging-port=${PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    {
      stdio: 'ignore',
      detached: false,
      env: {
        ...process.env,
        /* ★ 让被 Edge 拉起的 node.exe 直接执行探针脚本。
           NODE_OPTIONS **不能带引号** —— 实测引号会被吞掉，路径变成
           `E:CodexWorkbench harbor-edge...`（模块找不到）；而且脚本必须是 .cjs，
           因为本仓 package.json 有 `"type":"module"`，.js 会被当 ESM（require 不可用）。 */
        NODE_OPTIONS: `--require ${HOST_SCRIPT}`,
        HARBOR_PHASE0_LOG: HOST_LOG,
      },
    },
  )
  console.log(`Edge PID=${child.pid}（环境里带了 NODE_OPTIONS）`)

  let verdict = '（未测到）'
  try {
    for (let i = 0; i < 30; i++) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/json/version`)
        break
      } catch {
        await sleep(500)
      }
    }
    await sleep(4000)
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const sw = targets.find((t) => t.type === 'service_worker' && String(t.url).includes(EXT_ID))
    if (!sw) {
      verdict = '✗ 没找到扩展 SW'
    } else {
      const cdp = connect(sw.webSocketDebuggerUrl)
      await cdp.ready
      await cdp.send('Runtime.enable')
      const r = await cdp.send('Runtime.evaluate', {
        expression: EVAL,
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
    spawnSync('reg', ['DELETE', KEY, '/f', '/reg:64'], { encoding: 'utf8' })
    spawnSync('reg', ['DELETE', KEY, '/f', '/reg:32'], { encoding: 'utf8' })
    await sleep(800)
  }

  console.log(`\n=== connectNative 结果 ===\n  ${verdict}`)

  if (fs.existsSync(HOST_LOG)) {
    const entries = JSON.parse(fs.readFileSync(HOST_LOG, 'utf8'))
    console.log(`\n=== host 侧记录（${entries.length} 条）★ host 被拉起了 ===`)
    const started = entries.find((e) => e.stage === 'started')
    if (started) {
      console.log('  argv =')
      started.argv.forEach((a, i) => console.log(`    [${i}] ${a}`))
      console.log(`  cwd = ${started.cwd}`)
      console.log(`  node = ${started.node}`)
    }
    for (const e of entries.filter((x) => x.stage !== 'started')) {
      console.log(`  ${e.stage}: ${JSON.stringify(e.message ?? e)}`)
    }

    console.log('\n══════ 判定 ══════')
    const argv1 = started?.argv?.[1] ?? ''
    console.log(`  ① argv[1] 是 origin（chrome-extension://…）？ ${argv1.startsWith('chrome-extension://') ? '★ 是' : '否'}`)
    const pw = (started?.argv ?? []).find((a) => a.startsWith('--parent-window='))
    console.log(`  ② 有 --parent-window= ？ ${pw ? '★ 有：' + pw : '没有'}`)
    const ok = String(verdict).includes('"ok":true')
    console.log(`  ③ 协议跑通（ping → pong）？ ${ok ? '★ 是' : '否'}`)
  } else {
    console.log('\n✗ host 一个字节都没写 —— 这一形态不通过')
  }
}

main().catch((e) => console.log('ERR', e.message))
