/**
 * Edge 扩展验收用的小工具（Phase 2 拆出来的，`accept-phase2.cjs` 已 300 行）
 *
 * 三件事：
 *   · `findServiceWorker` —— 从 CDP 的 target 列表里找到扩展的 SW
 *   · `evalInTarget`      —— 在某个 target 上求值（带 awaitPromise）
 *   · `runHost`           —— 起真 host 进程喂帧、把回复帧解回来
 *
 * 为什么不放 tools/ 里内联：Phase 3 的验收还要用同一套（读 SW / 求值 / 喂帧），
 * 抄一份就会漂 —— 与 `lib/driver.cjs` 同一个理由。
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 把求值回来的东西安全地解析成对象。
 *
 * ⚠️ CDP 的 `returnByValue` 有时**直接给对象**、有时给 JSON 字符串
 *   （实测：同一个表达式在不同 target 上两种都出现过）。所以两条路都要认 ——
 *   只处理字符串的话，对象会被 `String()` 成 `[object Object]`，
 *   断言就变成「永远失败」的假红。
 */
function safeJson(value) {
  if (value && typeof value === 'object') return value
  const s = String(value ?? '')
  try {
    return JSON.parse(s)
  } catch {
    /* 可能是被再包了一层引号的 JSON 字符串 */
  }
  try {
    return JSON.parse(s.replace(/^"|"$/g, '').replace(/\\"/g, '"'))
  } catch {
    return null
  }
}

/** 找扩展的 Service Worker target（轮询，别信固定等待） */
async function findServiceWorker(port, extId, { tries = 20, gapMs = 500 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const hit = list.find((t) => String(t.url || '').includes(extId) && t.webSocketDebuggerUrl)
      if (hit) return hit
    } catch {
      /* Edge 还没就绪，再试 */
    }
    await sleep(gapMs)
  }
  return null
}

/** 在某个 target 上求值（awaitPromise，超时兜底） */
function evalInTarget(wsUrl, expression, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl)
    const id = 1
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      try {
        ws.close()
      } catch {
        /* 忽略 */
      }
      resolve(v)
    }
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      )
    })
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === id) finish(msg.result?.result?.value)
    })
    ws.addEventListener('error', () => finish(undefined))
    setTimeout(() => finish(undefined), timeoutMs)
  })
}

/**
 * 起真 host 进程，把帧喂进去、把回复帧解回来。
 *
 * 两种形态：
 *   · 给了 `cmd`   → 用**生产的 .cmd 包装器**（.cmd + ELECTRON_RUN_AS_NODE）
 *   · 否则给 `exe` → 直接 `exe native-host.cjs`（exe 用 Harbor.exe 才是真形态）
 *
 * @returns {Promise<{replies: object[], err: string}>}
 */
function runHost({ cmd, exe, frames, dataRoot, waitMs = 1200 }) {
  return new Promise((resolve) => {
    const NH = require(path.join(ROOT, 'electron', 'native-host.cjs'))
    const child = cmd
      ? spawn(cmd, [], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(exe || process.execPath, [path.join(ROOT, 'electron', 'native-host.cjs')], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARBOR_DATA_ROOT: dataRoot || '' },
          stdio: ['pipe', 'pipe', 'pipe'],
        })

    const out = []
    let err = ''
    child.stdout.on('data', (b) => out.push(b))
    child.stderr.on('data', (b) => (err += b.toString()))
    for (const f of frames) child.stdin.write(NH.encodeFrame(f))

    setTimeout(() => {
      child.stdin.end()
      setTimeout(() => {
        /* ★ 必须 taskkill /T /F —— `child.kill()` 在 Windows 上杀不掉 Electron（实测踩到：
           host 还活着、连着那条管道，于是 `server.close(cb)` 的回调永不触发 → 验收挂死）。 */
        try {
          child.kill()
        } catch {
          /* 已退 */
        }
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        setTimeout(() => resolve({ replies: decodeFrames(Buffer.concat(out)), err }), 300)
      }, waitMs)
    }, waitMs)
  })
}

/** 从字节流里切出所有完整帧 */
function decodeFrames(buf) {
  const replies = []
  let off = 0
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32LE(off)
    if (len > 4 * 1024 * 1024 || off + 4 + len > buf.length) break
    try {
      replies.push(JSON.parse(buf.subarray(off + 4, off + 4 + len).toString('utf8')))
    } catch {
      break
    }
    off += 4 + len
  }
  return replies
}

/** 把构建产物 + manifest 拷成一个可加载的扩展目录 */
function stageExtension(distDir, stageDir) {
  fs.rmSync(stageDir, { recursive: true, force: true })
  fs.mkdirSync(stageDir, { recursive: true })
  fs.cpSync(distDir, stageDir, { recursive: true })
  return { dir: stageDir, hasManifest: fs.existsSync(path.join(stageDir, 'manifest.json')) }
}

/**
 * 触发一个异步动作，然后**轮询读它落到 `globalThis` 的结果**。
 *
 * ★ 为什么要这么绕（实测踩出来的）：
 *   直接 `Runtime.evaluate("chrome.runtime.sendMessage(…).then(r => JSON.stringify(r))")`
 *   拿回来是 **`{}`** —— CDP 序列化 Chrome 的**原生 Promise** 时给不出里面的值
 *   （returnByValue 对它无能为力）。这不是产品问题，是调试通道的限制。
 *   所以改成：表达式**把结果写进 `globalThis.__probe`**，再轮询读那个变量 ——
 *   与 `harbor-edge/README.md` 的硬规则一致（轮询目标状态，别信固定等待）。
 *
 * @param {string} wsUrl target 的 ws 地址
 * @param {string} kickExpr 触发用的表达式（应尽快返回）
 * @param {(v: any) => boolean} test 判据（结果出现才算成功）
 */
async function triggerAndPoll(wsUrl, kickExpr, test, { tries = 25, gapMs = 400, slot = '__probe' } = {}) {
  await evalInTarget(
    wsUrl,
    `(() => {
       try { globalThis.${slot} = ''; } catch (e) {}
       Promise.resolve(${kickExpr})
         .then((r) => { globalThis.${slot} = typeof r === 'string' ? r : JSON.stringify(r) })
         .catch((e) => { globalThis.${slot} = JSON.stringify({ ok: false, error: String((e && e.message) || e) }) });
       return 'started';
     })()`,
  )
  let last = null
  for (let i = 0; i < tries; i += 1) {
    await sleep(gapMs)
    const raw = await evalInTarget(wsUrl, `String(globalThis.${slot} || '')`)
    const parsed = safeJson(raw)
    last = parsed
    if (parsed && test(parsed)) return parsed
  }
  return last
}

/** 在扩展的 SW 里实测 activeTab 的真实行为（CDP 驱动下拿不到是正常的） */
async function probeActiveTab(swUrl) {
  return safeJson(
    await evalInTarget(
      swUrl,
      `(async () => {
         const out = {};
         try {
           const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
           out.tabs = tabs.length;
           out.url = tabs[0] ? (tabs[0].url || '') : null;
           out.tabId = tabs[0] ? (tabs[0].id ?? null) : null;
         } catch (e) { out.tabsErr = String(e && e.message); }
         try {
           if (out.tabId != null) {
             const r = await chrome.scripting.executeScript({
               target: { tabId: out.tabId },
               func: () => document.body.innerText.slice(0, 200),
             });
             out.execOk = true;
             out.execText = (r && r[0] && r[0].result) || '';
           }
         } catch (e) { out.execErr = String((e && e.message) || e); }
         return JSON.stringify(out);
       })()`,
    ),
  )
}

/** 侧边栏上那句状态文案（`role=status[aria-live=polite]` 那个元素） */
const STATUS_TEXT_EXPR = `(document.querySelector('[role=status][aria-live=polite]') || {}).innerText || ''`

/** 侧边栏**还没读过**时的默认文案 —— 判「结果出来了没有」必须排除它 */
const IDLE_TEXT = '读取当前标签页的正文'

/**
 * 状态区是不是「已经出结果」了。
 *
 * ★ 为什么要排除默认文案：默认文案也满足「有文字、不是读取中」——
 *   不排除就会在结果出来之前命中（第一版真这么假过了一次）。
 */
function isResultText(v) {
  return typeof v === 'string' && v.length > 0 && !v.includes('读取中') && !v.includes(IDLE_TEXT)
}

/** 点侧边栏那个「读当前页」按钮 */
const CLICK_READ_EXPR = `(function(){
  const b = [...document.querySelectorAll('button')].find(x => /读当前页|读取中/.test(x.textContent));
  if (!b) return 'no-button';
  b.click();
  return 'clicked';
})()`

/** 点「重试」 */
const CLICK_RETRY_EXPR = `(function(){
  const b = [...document.querySelectorAll('button')].find(x => /重试/.test(x.textContent));
  if (b) b.click();
  return 'ok';
})()`

/* ══════════════════════════════════════════════════════════════
   Phase 3a：会话列表（**唯一真相源** —— accept-phase3a 用它找元素）
   ══════════════════════════════════════════════════════════════ */

/**
 * 读会话列表区块当前渲染出来的东西（条数 + 每条的标题/时间）。
 *
 * ★ 按 `aria-label` 找区块，不按 class —— class 会随样式重构变，可访问名字不会。
 *   （渲染层改了 aria-label，这里要同步；否则脚本会**静默失效**，
 *     与 `tools/shot/cards.mjs` 那条规矩一样。）
 */
const SESSION_LIST_EXPR = `(function(){
  const sec = document.querySelector('[aria-label="Harbor 会话列表"]');
  if (!sec) return JSON.stringify({ found: false });
  const items = [...sec.querySelectorAll('li')].map(li => li.innerText.split('\\n'));
  return JSON.stringify({ found: true, text: sec.innerText, count: items.length, items });
})()`

/** 点「刷新」按钮（按它自己的 aria-label 找） */
const CLICK_REFRESH_EXPR = `(function(){
  const b = document.querySelector('[aria-label="刷新会话列表"]')
    || [...document.querySelectorAll('button')].find(x => /刷新/.test(x.textContent));
  if (!b) return 'no-button';
  b.click();
  return 'clicked';
})()`

module.exports = {
  ROOT,
  sleep,
  safeJson,
  findServiceWorker,
  evalInTarget,
  triggerAndPoll,
  probeActiveTab,
  STATUS_TEXT_EXPR,
  isResultText,
  CLICK_READ_EXPR,
  CLICK_RETRY_EXPR,
  SESSION_LIST_EXPR,
  CLICK_REFRESH_EXPR,
  runHost,
  decodeFrames,
  stageExtension,
}
