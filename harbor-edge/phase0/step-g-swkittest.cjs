/**
 * Phase 0 · 步骤 G：对照实验 —— 
 *   ① 验证「node.exe 抢读 stdin」是不是 Edge 报 communicating error 的原因
 *   ② 实测 Edge 155 里「活跃 native port 能否保活 SW」（点 4）
 *
 * 设计：
 *   A) 只建立连接、**不发消息** → 若 node 抢 stdin 的解释成立，进程应保持存活；
 *      同时这就是 SW 保活实验：45 秒后看连接还在不在。
 *   B) 发一条消息           → node 把二进制帧当 JS 求值 → 立刻崩 → communicating error
 *
 * ★ 关键细节：CDP 的 debugger 会话本身会保活 SW（Chrome 118+ 明文），
 *   所以「触发连接」之后**必须断开 CDP**，再等 45 秒 —— 否则测的是 debugger 不是 port。
 *   45 秒后重连读 globalThis，读不到就说明 SW 真被终止过。
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
const HOST_LOG = path.join(BASE, 'host-report-g.json')
const HOST_NAME = 'com.harbor.phase0.probe'
const EXT_ID = 'fgiopdanmkafnmpcjiiofkbbgikmdljn'
const KEY = `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

async function findSW(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  const targets = await res.json()
  return targets.find((t) => t.type === 'service_worker' && String(t.url).includes(EXT_ID))
}

/** 在 SW 里执行一段表达式 */
async function evalInSW(port, expression) {
  const sw = await findSW(port)
  if (!sw) return { error: 'SW 不在 target 列表里' }
  const cdp = connect(sw.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  cdp.ws.close()
  /* ★ 打印用：统一成字符串（否则对象会打成 [object Object]，判读会出错） */
  const v = r?.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v ?? r)
}

const CONNECT_ONLY = `
(async () => {
  const out = {};
  globalThis.__t0 = Date.now();
  globalThis.__events = [];
  try {
    const port = chrome.runtime.connectNative(${JSON.stringify(HOST_NAME)});
    globalThis.__port = port;
    port.onDisconnect.addListener(() => {
      globalThis.__events.push({ type: 'disconnect', at: Date.now() - globalThis.__t0, err: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
    });
    port.onMessage.addListener((m) => globalThis.__events.push({ type: 'message', at: Date.now() - globalThis.__t0, m }));
  } catch (e) {
    return JSON.stringify({ threw: String(e && e.message) });
  }
  /* ★ 先等 2500ms 看 port 到底建没建立 ——
     如果 host 端谈不成协议，port 会**立刻** disconnect，
     那么后面 45 秒的「存活」测的就不是保活，而是「压根没连上」。 */
  await new Promise((r) => setTimeout(r, 2500));
  out.started = true;
  out.eventsAfter2s = globalThis.__events;
  return JSON.stringify(out);
})()
`

const SEND_ONE = `
(() => {
  try {
    const port = chrome.runtime.connectNative(${JSON.stringify(HOST_NAME)});
    port.onDisconnect.addListener(() => {
      globalThis.__lastErr = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
    });
    port.postMessage({ ping: 1 });
  } catch (e) {
    return JSON.stringify({ threw: String(e && e.message) });
  }
  return JSON.stringify({ sent: true });
})()
`

const READ_STATE = `
JSON.stringify({
  hasT0: typeof globalThis.__t0,
  aliveMs: globalThis.__t0 ? Date.now() - globalThis.__t0 : null,
  events: globalThis.__events ?? null,
  lastErr: globalThis.__lastErr ?? null,
})
`

async function trial(label, { mode, waitMs, port }) {
  console.log(`\n──────── ${label} ────────`)
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: 'Harbor Phase 0 native messaging probe',
        path: NODE, // ★ 纯 exe，不带参数（A 组已是结论）
        type: 'stdio',
        allowed_origins: [`chrome-extension://${EXT_ID}/`],
      },
      null,
      2,
    ),
  )
  spawnSync('reg', ['ADD', KEY, '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f', '/reg:64'], {
    encoding: 'utf8',
  })
  try {
    fs.unlinkSync(HOST_LOG)
  } catch {
    /* */
  }

  const profile = path.join(BASE, `edge-trial-g${port}`)
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
    {
      stdio: 'ignore',
      detached: false,
      env: { ...process.env, NODE_OPTIONS: `--require ${HOST_SCRIPT}`, HARBOR_PHASE0_LOG: HOST_LOG },
    },
  )

  const out = {}
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

    const expr = mode === 'send' ? SEND_ONE : CONNECT_ONLY
    out.firstEval = await evalInSW(port, expr)
    console.log(`  发起连接 → ${out.firstEval}`)

    /* ★ 断开 CDP（它会保活 SW），然后干等 */
    console.log(`  已断开 CDP，等待 ${waitMs / 1000} 秒（期间没有任何 debugger 附着）…`)
    await sleep(waitMs)

    out.secondEval = await evalInSW(port, READ_STATE)
    console.log(`  ${waitMs / 1000} 秒后读状态 → ${out.secondEval}`)

    if (mode === 'send') {
      out.sendCheck = await evalInSW(port, READ_STATE)
    }
  } catch (e) {
    out.err = e.message
    console.log(`  ✗ 异常：${e.message}`)
  } finally {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    spawnSync('reg', ['DELETE', KEY, '/f', '/reg:64'], { encoding: 'utf8' })
    spawnSync('reg', ['DELETE', KEY, '/f', '/reg:32'], { encoding: 'utf8' })
    await sleep(700)
  }

  console.log('  --- host 侧日志 ---')
  if (fs.existsSync(HOST_LOG)) {
    const entries = JSON.parse(fs.readFileSync(HOST_LOG, 'utf8'))
    console.log(`  记录 ${entries.length} 条：${entries.map((e) => e.stage).join(', ')}`)
    for (const e of entries.filter((x) => x.stage !== 'started')) {
      console.log(`    ${e.stage}: ${JSON.stringify(e.message ?? '').slice(0, 120)}`)
    }
    out.hostStages = entries.map((e) => e.stage)
  } else {
    console.log('  （host 一个字节都没写）')
    out.hostStages = []
  }
  return out
}

async function main() {
  const mode = process.argv.includes('--send') ? 'send' : 'connect'
  const waitMs = Number(process.argv.find((a) => a.startsWith('--wait='))?.slice(7) ?? 45000)
  const port = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 9441)

  const r = await trial(mode === 'send' ? 'B) 发一条消息（预期：node 崩 → communicating error）' : 'A) 只连接不发消息（预期：保持存活 → 同时测 SW 保活）', {
    mode,
    waitMs,
    port,
  })

  console.log('\n══════ 判定 ══════')
  if (mode === 'send') {
    console.log(`  host 阶段: ${JSON.stringify(r.hostStages)}`)
    console.log(`  是否出现 stdin-ended（host 被切断）: ${(r.hostStages ?? []).includes('stdin-ended') ? '★ 是' : '否'}`)
  } else {
    console.log(`  host 阶段: ${JSON.stringify(r.hostStages)}`)
    const survived = (r.hostStages ?? []).includes('started') && !(r.hostStages ?? []).includes('stdin-ended')
    console.log(`  ① 45 秒后 host 连接仍未被切断: ${survived ? '★ 是（node 抢 stdin 的解释成立）' : '否'}`)
    let alive = false
    try {
      const parsed = JSON.parse(r.secondEval)
      alive = parsed.hasT0 === 'number' && parsed.aliveMs > waitMs * 0.8
    } catch {
      /* */
    }
    console.log(`  ② 45 秒后 SW 上下文仍在（globalThis 未丢）: ${alive ? '★ 是 → 点 4 通过' : '否 → 需按 onDisconnect 重连'}`)
  }
}

main().catch((e) => console.log('ERR', e.message))
