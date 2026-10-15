/**
 * Phase 0 · 步骤 H：path 指向 `.cmd` 包装器 —— 能否被 Edge 当 host 启动？
 *
 * 动机：node.exe 直接当 host 走不通（无参数时它把 stdin 当**脚本源**读掉，
 * 协议永远收不到数据）。若 Edge 能启动 `.cmd`，那就有一层包装可用来传脚本参数。
 *
 * 顺带：若本形态协议跑通，就**接着测点 4（45 秒保活）** —— 这是一个真正健康的端口。
 */
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'E:\\CodexWorkbench\\harbor-edge\\phase0'
const EXT = path.join(BASE, 'ext')
const CMD = path.join(BASE, 'host.cmd')
const MANIFEST = path.join(BASE, 'com.harbor.phase0.probe.json')
const HOST_LOG = path.join(BASE, 'host-report-h.json')
const HOST_NAME = 'com.harbor.phase0.probe'
const EXT_ID = 'fgiopdanmkafnmpcjiiofkbbgikmdljn'
const KEY = `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`
const PORT = 9451
const WAIT = Number(process.argv.find((a) => a.startsWith('--wait='))?.slice(7) ?? 0)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
  })
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res())
    ws.addEventListener('error', () => rej(new Error('ws error')))
  })
  return {
    ws,
    ready,
    send(method, params) {
      const myId = ++id
      return new Promise((res, rej) => {
        pending.set(myId, { resolve: res, reject: rej })
        ws.send(JSON.stringify({ id: myId, method, params }))
        setTimeout(() => {
          if (pending.has(myId)) {
            pending.delete(myId)
            rej(new Error('CDP 超时 ' + method))
          }
        }, 12000)
      })
    },
  }
}

async function swEval(port, expression) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const sw = list.find((t) => t.type === 'service_worker' && String(t.url).includes(EXT_ID))
  if (!sw) return '（SW 不在 target 列表里）'
  const cdp = cdpConnect(sw.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  cdp.ws.close()
  const v = r?.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v ?? r)
}

const PING = `
(async () => {
  globalThis.__t0 = Date.now();
  globalThis.__ev = [];
  let port;
  try { port = chrome.runtime.connectNative(${JSON.stringify(HOST_NAME)}); }
  catch (e) { return JSON.stringify({ threw: String(e && e.message) }); }
  globalThis.__port = port;
  port.onDisconnect.addListener(() => globalThis.__ev.push({ t: Date.now() - globalThis.__t0, type: 'disconnect', err: chrome.runtime.lastError ? chrome.runtime.lastError.message : null }));
  const got = await new Promise((resolve) => {
    let done = false;
    port.onMessage.addListener((m) => { if (!done) { done = true; resolve({ ok: true, msg: m }); } });
    setTimeout(() => { if (!done) { done = true; resolve({ ok: false, timeout: true }); } }, 6000);
    try { port.postMessage({ ping: 1 }); } catch (e) { resolve({ ok: false, postErr: String(e && e.message) }); }
  });
  return JSON.stringify({ ping: got, events: globalThis.__ev });
})()
`

const STATE = `JSON.stringify({ hasT0: typeof globalThis.__t0, aliveMs: globalThis.__t0 ? Date.now() - globalThis.__t0 : null, ev: globalThis.__ev ?? null })`

async function main() {
  console.log(`=== path = ${CMD}（.cmd 包装器）===\n`)
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: 'Harbor Phase 0 probe (.cmd wrapper)',
        path: CMD,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${EXT_ID}/`],
      },
      null,
      2,
    ),
  )
  spawnSync('reg', ['ADD', KEY, '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f', '/reg:64'], { encoding: 'utf8' })
  try {
    fs.unlinkSync(HOST_LOG)
  } catch {
    /* */
  }

  const profile = path.join(BASE, 'edge-trial-h')
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
    { stdio: 'ignore', detached: false, env: { ...process.env, HARBOR_PHASE0_LOG: HOST_LOG } },
  )

  try {
    for (let i = 0; i < 30; i++) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/json/version`)
        break
      } catch {
        await sleep(500)
      }
    }
    await sleep(3500)
    const ping = await swEval(PORT, PING)
    console.log(`  ping 结果 = ${ping}`)

    const log1 = fs.existsSync(HOST_LOG) ? JSON.parse(fs.readFileSync(HOST_LOG, 'utf8')) : []
    console.log(`  host 阶段 = ${JSON.stringify(log1.map((e) => e.stage))}`)
    const started = log1.find((e) => e.stage === 'started')
    if (started) console.log(`  host argv = ${JSON.stringify(started.argv)}`)
    const got = log1.find((e) => e.stage === 'got-message')
    if (got) console.log(`  ★ host 收到 = ${JSON.stringify(got.message)}`)

    const ok = String(ping).includes('"ok":true')
    console.log(`\n  ★ 协议跑通 = ${ok ? '是' : '否'}`)

    if (ok && WAIT > 0) {
      console.log(`\n  → 端口是健康的，接着测保活：断开 CDP，等 ${WAIT / 1000} 秒`)
      await sleep(WAIT)
      console.log(`  ${WAIT / 1000} 秒后 = ${await swEval(PORT, STATE)}`)
    }
  } catch (e) {
    console.log('  ✗ ' + e.message)
  } finally {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    spawnSync('reg', ['DELETE', KEY, '/f', '/reg:64'], { encoding: 'utf8' })
    spawnSync('reg', ['DELETE', KEY, '/f', '/reg:32'], { encoding: 'utf8' })
    console.log('\n已收尾')
  }
}

main().catch((e) => console.log('ERR', e.message))
