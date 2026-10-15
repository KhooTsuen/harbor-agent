/**
 * Phase 1c 第二步验收：**真扩展 + 真 native host 端到端**。
 *
 * 链路全真：
 *   真 Edge 加载构建产物（harbor-edge/dist/sidepanel）
 *     → SW 启动时 connectNative('com.harbor.agent')
 *     → 注册表指向 harbor-host.cmd（ELECTRON_RUN_AS_NODE + Harbor.exe + native-host.cjs）
 *     → 真 Harbor.exe 起、回 {"pong":1}
 *     → SW 收到 → 广播 → 侧边栏 DOM 显示「已连接」
 *
 * ★ 判据为什么是**DOM 上的文字**：那条文字只能由「host 真的回了消息」推出来 ——
 *   中间任何一环断了（注册表没写、host 没起、协议不对、SW 没连）都会停在「未连接」。
 *   所以它不是「界面看起来对不对」，是端到端的硬判据。
 *
 * 隔离：独立 profile；注册表用完即卸；跑完杀进程 + 删 profile。
 * 全程**不碰**用户正在用的 Edge 与 Harbor。
 *
 * 用法（项目根）：node harbor-edge/tools/accept-extension.cjs
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const D = require('../lib/driver.cjs')

const BASE = path.resolve(__dirname, '..')
const DIST = path.join(BASE, 'dist', 'sidepanel')
const INSTALL = path.join(BASE, 'install-host.cmd')
const UNINSTALL = path.join(BASE, 'uninstall-host.cmd')
const PROFILE = 'profile-1c2-accept'
const PORT = 9480
const HOST_NAME = 'com.harbor.agent'
const KEY = D.keyOf(HOST_NAME)

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  -- ${detail}`)
}

/** 跑一个 .cmd，回显它的输出 */
function runCmd(file, args = []) {
  const r = spawnSync('cmd', ['/c', file, ...args], { cwd: path.resolve(BASE, '..'), encoding: 'utf8' })
  if (r.stdout) process.stdout.write(r.stdout.replace(/^/gm, '    | '))
  if (r.stderr) process.stderr.write(r.stderr)
  return r.status
}

/** 注册表里当前指向哪个清单（读出来复核，不信脚本自述） */
function queryKey() {
  const r = spawnSync('reg', ['QUERY', KEY, '/ve'], { encoding: 'utf8' })
  return { rc: r.status, out: (r.stdout ?? '').trim() }
}

async function main() {
  console.log('=== Phase 1c step 2: real extension + native host ===\n')

  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    console.error(`[X] 构建产物不在：${DIST}\n    先跑：npx vite build --config harbor-edge/vite.config.ext.ts`)
    process.exit(1)
  }

  let edge = null
  let installed = false
  try {
    /* ── 1. 装 host（会自己起一次 Edge 读真实扩展 ID）── */
    console.log('[install] 跑 install-host.cmd ...')
    if (runCmd(INSTALL) !== 0) throw new Error('install-host.cmd 失败')
    installed = true

    const q = queryKey()
    rec('① 注册表已写（指向 com.harbor.agent 的清单）', q.rc === 0 && q.out.includes(HOST_NAME), `rc=${q.rc}`)

    /* ── 2. 起隔离 Edge 加载构建产物 ── */
    console.log('\n[edge] 起隔离 Edge 加载构建产物 ...')
    edge = await D.launchEdge({ profileName: PROFILE, port: PORT, extDir: DIST, waitMs: 1500 })
    if (!edge.ready) throw new Error('Edge 没起来')

    /* 轮询读扩展 ID（不许固定等待 —— 见 harbor-edge/README.md） */
    let extId = null
    for (let i = 0; i < 30 && !extId; i += 1) {
      await D.sleep(500)
      extId = D.readExtIdFromProfile(edge.profile, DIST)
    }
    console.log(`  extension id = ${extId}`)
    if (!extId) throw new Error('读不到扩展 ID（扩展没被加载？）')

    /* ── 3. 打开侧边栏页，轮询等它变成「已连接」── */
    const url = `chrome-extension://${extId}/index.html`
    console.log(`  opening = ${url}\n`)
    const tab = await D.openTab(PORT, url)

    const READ = `(function(){
      const txt = document.body ? document.body.innerText : '';
      const cs = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el) : null; };
      const root = document.querySelector('.bg-canvas');
      const dot = document.querySelector('[role="status"]');
      const ta = document.querySelector('textarea');
      const btn = document.querySelector('button');
      return JSON.stringify({
        text: txt,
        connected: txt.includes('已连接'),
        disconnected: txt.includes('未连接'),
        rootBg: cs('.bg-canvas') ? cs('.bg-canvas').backgroundColor : null,
        rootColor: root ? getComputedStyle(root).color : null,
        dotBg: dot ? getComputedStyle(dot).backgroundColor : null,
        dotLabel: dot ? dot.getAttribute('aria-label') : null,
        hasTextarea: Boolean(ta),
        textareaDisabled: ta ? ta.disabled : null,
        buttonBg: btn ? getComputedStyle(btn).backgroundColor : null,
        buttonColor: btn ? getComputedStyle(btn).color : null,
        nodeCount: document.querySelectorAll('*').length,
        stylesheets: document.styleSheets.length
      });
    })()`
    /* ★ 轮询到「已连接」为止（最多 20 秒）—— 判据是状态真的出现了 */
    const wait = await D.pollEval(tab, READ, (v) => {
      if (typeof v !== 'string') return false
      try {
        return JSON.parse(v).connected === true
      } catch {
        return false
      }
    })

    const r = JSON.parse(wait.value ?? '{}')
    if (!wait.ok) {
      console.log('  （等满了仍未见「已连接」，最后一次读到的：）')
      console.log(`   text = ${JSON.stringify((r.text ?? '').slice(0, 200))}`)
    }
    console.log(`  rendered = ${JSON.stringify(r, null, 1)}\n`)

    rec('② 侧边栏页面加载（DOM 有内容）', r.nodeCount > 3, `节点数=${r.nodeCount}`)
    rec('③ ★ 显示「已连接」（端到端：host 真回了消息）', r.connected === true, `connected=${r.connected} 等了 ${wait.tries} 轮`)
    rec('④ 状态点文案 = 已连接', r.dotLabel === '已连接', `aria-label=${JSON.stringify(r.dotLabel)}`)

    /*
     * 样式判据一律用**实际像素值**，且每个值都要指得到源码里的一个变量
     * （第一步的教训：只看类名在不在 = 没验）。
     *
     * ★ 这里最容易写错的是「该等于哪个值」—— 第一步我先写成 rgb(16,16,16)，
     *   那是 `src/index.css` 的 default 主题（#101010）。但 sidepanel.css 在它
     *   **之后**还引了 `src/styles/theme-primer-dark.css`（与主应用 main.tsx 同序），
     *   Primer 深色把 --bg-canvas 覆盖成 var(--bg-default) = #0d1117。
     *   所以正确值是 rgb(13,17,23) —— **也就是主应用实际渲染的那个值**。
     *   出处：theme-primer-dark.css:83（--bg-default:#0d1117）/ :125（--bg-canvas）。
     */
    rec('⑤ ★ 背景 == Primer 深色 --bg-canvas（#0d1117，与主应用一致）', r.rootBg === 'rgb(13, 17, 23)', `background=${r.rootBg}`)
    rec('⑤b ★ 文字色 == --text-primary（--fg-default #f0f6fc）', r.rootColor === 'rgb(240, 246, 252)', `color=${r.rootColor}`)
    rec('⑥ ★ 状态点 == --success（--success-fg #3fb950）', r.dotBg === 'rgb(63, 185, 80)', `dot bg=${r.dotBg}`)
    rec('⑦ 输入框是占位态（disabled）', r.hasTextarea === true && r.textareaDisabled === true, `textarea=${r.hasTextarea} disabled=${r.textareaDisabled}`)
    /*
     * ⑧ 复用 Button 的判据看**文字色**，不是背景：
     *   ghost 变体的类里就是 `bg-transparent`，背景透明是**正确**的
     *   （第一版断言写成「有背景色」太弱 —— 透明也放行）。
     *   文字色 rgb(145,152,161) = #9198a1 = theme-primer-dark.css:88 的
     *   --fg-muted（:143 挂到 --text-secondary）；Button 走 `text-fg-secondary`。
     *   它能算出来 = 跨目录那份 Button.tsx 的类**真被 Tailwind 编出来了**。
     */
    rec('⑧ ★ 复用的 Button 文字色 == --text-secondary（跨目录 theme 生效）', r.buttonColor === 'rgb(145, 152, 161)', `button color=${r.buttonColor} bg=${r.buttonBg}`)
    rec('⑨ 外部样式表被加载', r.stylesheets >= 1, `stylesheets=${r.stylesheets}`)

    tab.close()
  } finally {
    /* ── 收尾：卸 host + 杀进程 + 删 profile，顺序不能反 ── */
    if (edge) {
      D.killEdge(edge.child.pid)
      await D.sleep(1200)
    }
    if (installed) {
      console.log('\n[uninstall] 跑 uninstall-host.cmd ...')
      runCmd(UNINSTALL)
    }
    if (edge) {
      const removed = D.removeProfile(edge.profile)
      console.log(`清理：profile 删除=${removed}`)
    }
    const after = queryKey()
    console.log(`清理：注册表 rc=${after.rc}（非 0 = 已删干净）`)
  }

  const failed = results.filter((x) => !x.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
  if (failed.length) console.log(`失败：${failed.map((f) => f.name).join(' / ')}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
