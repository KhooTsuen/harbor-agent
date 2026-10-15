/**
 * Phase 1c 第一步验收：构建产物**真能被 Edge 当扩展页加载并渲染**。
 *
 * 为什么非得起真 Edge：本步要证的是「可加载」。
 * 光看 dist 里有 index.html / CSS / JS 不够 —— 相对路径、CSP、资源解析
 * 这些问题只在真浏览器里才现形。
 *
 * 判据（三条，缺一不算过）：
 *   ① 页面能打开（读得到 DOM）
 *   ② "Hello Harbor" 渲染出来了（React 真的挂载了）
 *   ③ **样式真的生效** —— 这个最关键：
 *      Tailwind 的 theme 出的是 `var(--x)`，变量没定义就会「类在、色空」。
 *      所以读 computed style 的**实际像素值**（不是看类名在不在）。
 *
 * 隔离：独立 profile；跑完杀进程 + 删 profile。
 */

const fs = require('node:fs')
const path = require('node:path')
const { launchEdge, killEdge, removeProfile, readExtIdFromProfile, sleep } = require('../lib/driver.cjs')

const BASE = path.resolve(__dirname, '..')
const DIST = path.join(BASE, 'dist', 'sidepanel')
const PROBE = path.join(BASE, 'dist', 'load-probe')
const PROFILE = 'profile-1c1-load'
const PORT = 9470

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  -- ${detail}`)
}

/** 把构建产物包成一个最小 MV3 扩展 */
function stageExtension() {
  fs.rmSync(PROBE, { recursive: true, force: true })
  fs.mkdirSync(PROBE, { recursive: true })
  fs.cpSync(DIST, PROBE, { recursive: true })
  fs.writeFileSync(
    path.join(PROBE, 'manifest.json'),
    JSON.stringify(
      {
        manifest_version: 3,
        name: 'Harbor Sidepanel Build Probe',
        version: '0.0.1',
        description: 'Phase 1c step 1: verify the sidepanel build chain',
        side_panel: { default_path: 'index.html' },
        permissions: ['sidePanel'],
      },
      null,
      2,
    ),
  )
  return PROBE
}

/** 用 CDP 开一个新标签并求值 */
async function openAndEval(port, url, expression) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  if (!res.ok) throw new Error(`/json/new 失败：${res.status}`)
  const target = await res.json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, no) => {
    ws.addEventListener('open', () => ok())
    ws.addEventListener('error', () => no(new Error('ws 连不上')))
  })
  let id = 0
  const call = (method, params) =>
    new Promise((ok, no) => {
      const myId = ++id
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id !== myId) return
        ws.removeEventListener('message', onMsg)
        msg.error ? no(new Error(JSON.stringify(msg.error))) : ok(msg.result)
      }
      ws.addEventListener('message', onMsg)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  /* 等 React 挂载（首帧）*/
  await sleep(1200)
  const out = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  ws.close()
  return out?.result?.value
}

async function main() {
  const extDir = stageExtension()
  console.log('=== Phase 1c step 1: load probe ===')
  console.log('staged extension =', extDir)

  let edge = null
  try {
    edge = await launchEdge({ profileName: PROFILE, port: PORT, extDir, waitMs: 2000 })
    if (!edge.ready) throw new Error('Edge 没起来')

    /*
     * ★ 轮询读扩展 ID，别信固定等待。
     *
     * 踩过（2026-10-15 本步第一次跑）：`waitMs` 定 3000 时 Secure Preferences
     * 还没落盘 → 读不到 ID → 整个验收假红。Edge 首次装扩展要写一堆东西，
     * 时间随机器变（Phase 1b 的 read-extid 也栽过同一个坑）。
     */
    let extId = null
    for (let i = 0; i < 30 && !extId; i++) {
      await sleep(500)
      extId = readExtIdFromProfile(edge.profile, extDir)
    }
    console.log('extension id =', extId)
    if (!extId) throw new Error('读不到扩展 ID（扩展没被加载？）')

    const url = `chrome-extension://${extId}/index.html`
    console.log('opening =', url)

    const data = await openAndEval(
      PORT,
      url,
      `(function(){
      const root = document.querySelector('.bg-canvas');
      const h1 = document.querySelector('h1');
      const cs = (el) => el ? getComputedStyle(el) : null;
      return JSON.stringify({
        title: document.title,
        text: document.body ? document.body.innerText : '',
        rootBg: cs(root) ? cs(root).backgroundColor : null,
        h1Text: h1 ? h1.textContent : null,
        h1Color: cs(h1) ? cs(h1).color : null,
        h1Size: cs(h1) ? cs(h1).fontSize : null,
        nodeCount: document.querySelectorAll('*').length,
        stylesheets: document.styleSheets.length
      });
    })()`,
    )

    const r = JSON.parse(data)
    console.log('rendered =', JSON.stringify(r, null, 1))
    console.log()

    rec('① 页面打开并读到 DOM', r.nodeCount > 3, `节点数=${r.nodeCount}`)
    rec('② React 挂载（"Hello Harbor" 渲染出来）', /Hello Harbor/.test(r.text), `text=${JSON.stringify(r.text.slice(0, 60))}`)

    /*
     * ③ 样式生效 —— 判据是**实际像素值**，不是类名。
     *    .bg-canvas 的 background-color 来自 var(--bg-canvas-rgb)=16 16 16
     *    → 浏览器算出来应是 rgb(16, 16, 16)。
     *    若变量没定义 → 会算成 rgba(0, 0, 0, 0)（透明）→ 这条会红。
     */
    const bgOk = r.rootBg === 'rgb(16, 16, 16)'
    rec('③ ★ CSS 变量真的生效（背景色算得出实值）', bgOk, `background-color=${r.rootBg}`)

    const colorOk = r.h1Color === 'rgb(248, 248, 248)'
    rec('③b ★ 文字色也走变量（--text-primary=#f8f8f8）', colorOk, `h1 color=${r.h1Color}`)

    const sizeOk = r.h1Size && r.h1Size !== '16px'
    rec('③c 自定义字号 token 生效（--text-title）', Boolean(sizeOk), `h1 font-size=${r.h1Size}`)

    rec('④ 外部样式表被加载', r.stylesheets >= 1, `stylesheets=${r.stylesheets}`)
  } finally {
    /* 无论成败都收尾 —— 别把隔离 profile 留在磁盘上（Phase 1b 的教训） */
    if (edge) {
      killEdge(edge.child.pid)
      await sleep(1200)
      const removed = removeProfile(edge.profile)
      console.log(`\n清理：profile 删除=${removed}`)
    }
  }

  const failed = results.filter((x) => !x.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
  process.exit(failed.length ? 1 : 0)
}


main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
