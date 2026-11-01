/**
 * 工具栏入口验收：**你在真 Edge 里点图标，脚本自动判定**
 *
 * ── 为什么这一步必须由人点（2026-10-20 实测四种手段，逐条有据）──
 *
 *   ① CDP `Input.dispatchMouseEvent` 只作用于**页面内容**，点不到浏览器 UI
 *   ② UIA 能枚举工具栏按钮，但**不支持 InvokePattern**；`ExpandCollapse.Expand()` 抛空错
 *   ③ 鼠标注入（`SetCursorPos` + `SendInput`）对工具栏**有效** ——
 *      点「设置及其他」真弹出菜单（`tmp/edge/uia7-settings.png` 可证）
 *   ④ 但 `--load-extension` 装的扩展**默认不在工具栏**（气泡消失后
 *      `ToolbarActionView` 列表为空）；`edge://extensions` 的 DOM 在 CDP 里读不到
 *      （`bodyLen: 0`）→ 没法自动固定图标
 *
 * 所以「点图标」这一下只能由人做。而**判据仍然可以很硬**：
 * `chrome.storage.local.harborInvoke` 只有 `chrome.action.onClicked` 被触发才会写
 * （`extension/service-worker.js` 的 `bindAction`）—— 它一出现就证明「点的确实是
 * 图标、走的是 action 入口」，不是别的东西冒充。
 *
 * ── 顺带验一件以前验不到的事 ──────────────────────────────────
 *
 * 产品 manifest **没有 host_permissions**，只靠 `activeTab`；而 `activeTab` 只有
 * 「用户点扩展图标」那一刻才授予。本脚本用**产品 manifest**（不加权限副本），
 * 因此能验到 `harborInvoke.hasUrl === true` —— 用「新开扩展页」冒充侧栏时永远验不到。
 *
 * 跑法：`node harbor-edge/tools/accept-toolbar-entry.cjs [--timeout=300]`
 */
const path = require('node:path')
const fs = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')

const D = require('../lib/driver.cjs')
const S = require('../lib/ext-stage.cjs')
const P = require('../lib/ext-probe.cjs')
const EP = require('../lib/ext-panel.cjs')

const ROOT = S.ROOT
/* 隔离根只放扩展副本（不碰用户 data/） */
const STAGE = path.join(ROOT, 'data', 'unit-test-data', 'toolbar-ext')
const PORT_EDGE = 9391
const PROFILE = 'profile-toolbar'
const DIST = path.join(ROOT, 'harbor-edge', 'dist', 'sidepanel')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const argv = process.argv.slice(2)
const TIMEOUT = (() => {
  const hit = argv.find((a) => a.startsWith('--timeout='))
  const n = hit ? Number(hit.split('=')[1]) : 0
  return Number.isFinite(n) && n > 0 ? n : 180
})()

let pass = 0
const failures = []
function rec(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}  -- ${String(detail ?? '').slice(0, 180)}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}  -- ${String(detail ?? '').slice(0, 300)}`)
  }
}

/** 读 service worker 里的 storage（侧栏与扩展状态都在那儿） */
async function swEval(extId, expr) {
  const list = await (await fetch(`http://127.0.0.1:${PORT_EDGE}/json/list`)).json()
  const sw = list.find((t) => t.type === 'service_worker' && String(t.url || '').includes(extId))
  if (!sw) return { err: 'service worker 不在（扩展没启用？）' }
  const c = await EP.connect(sw.webSocketDebuggerUrl)
  const v = await c.evalIn(expr)
  c.close()
  return { value: v }
}

/**
 * UIA：报告我们自己 Edge 窗口里工具栏上的按钮（**只读，绝不点击**）
 * ★ 只按 pid 过滤 —— 跨进程枚举会碰到用户正在用的 Edge（探测 8 踩过）。
 */
function reportToolbar(pid) {
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Continue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root=[System.Windows.Automation.AutomationElement]::RootElement
$cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${pid})
$ws=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$cond)
foreach($w in $ws){
  try{
    if($w.Current.ClassName -notlike 'Chrome_WidgetWin*'){ continue }
    $tc=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)
    foreach($e in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants,$tc)){
      try{
        $n=$e.Current.Name; if(-not $n){ continue }
        $rc=$e.Current.BoundingRectangle; if($rc.Width -le 0){ continue }
        $one=$n -replace "\`r?\n",' '
        Write-Output ($e.Current.AutomationId + '|' + $e.Current.ClassName + '|' + $one)
      }catch{}
    }
  }catch{}
}`,
    ],
    { encoding: 'utf8', timeout: 60000 },
  )
  return String(r.stdout || '').trim()
}

async function main() {
  const staged = P.stageExtension(DIST, STAGE)
  if (!staged.hasManifest) {
    console.log('✗ 构建产物不在（先跑 npx vite build --config harbor-edge/vite.config.ext.ts）')
    return
  }

  const profile = path.join(D.PROFILE_ROOT, PROFILE)
  D.removeProfile(profile)
  fs.mkdirSync(profile, { recursive: true })

  const child = spawn(
    D.edgeExe(),
    [
      `--user-data-dir=${profile}`,
      `--load-extension=${staged.dir}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch,msEdgeFirstRunExperience,Translate,msEdgeTranslate,msFeedback',
      `--remote-debugging-port=${PORT_EDGE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--no-service-autorun',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const pid = child.pid

  let ready = false
  for (let i = 0; i < 40 && !ready; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${PORT_EDGE}/json/version`)
      ready = true
    } catch {
      await sleep(500)
    }
  }
  await sleep(2000)

  let extId = ''
  for (let i = 0; i < 20 && !extId; i += 1) {
    await sleep(500)
    try {
      extId = D.readExtIdFromProfile(profile, staged.dir)
    } catch {
      extId = ''
    }
  }
  if (!extId) {
    console.log('✗ 读不到扩展 ID（扩展没被加载）')
    D.killEdge(pid)
    return
  }

  /* 一个真实的用户页面（工具栏入口的前提）；⑦ 要用它的 id 切前台 */
  const page = await (
    await fetch(`http://127.0.0.1:${PORT_EDGE}/json/new?${encodeURIComponent('https://example.com/')}`, { method: 'PUT' })
  ).json()
  await sleep(2500)

  console.log('\n════════════════════════════════════════════════════')
  console.log('  请手动操作（脚本在等，你点完它自动判定）')
  console.log('════════════════════════════════════════════════════')
  console.log(`  隔离 Edge 已起（pid=${pid}），扩展 ID = ${extId}`)
  console.log('  页面上应该已经打开 https://example.com/')
  console.log('')
  console.log('  要做的事：**点 Harbor 的侧栏入口**，两种点法都算：')
  console.log('    ① 工具栏上如果有 Harbor 图标 → 直接点它')
  console.log('    ② 没有的话 → 点工具栏的「扩展」按钮（拼图）→ 在列表里点 Harbor')
  console.log('')
  console.log(`  等 ${TIMEOUT} 秒；点完会自动往下判。`)
  console.log('════════════════════════════════════════════════════\n')

  /*
   * 辅助：把工具栏现状打出来（**只读，绝不点**）。
   * ★ 坑（实测）：Edge 会在图标位置贴**权限提示气泡**，UIA 名字是
   *   「Harbor 希望访问此站点 / 包含边栏体验」，Class 也是 ToolbarActionView。
   *   最初只判「名字含 Harbor + 是 ToolbarActionView」→ 把气泡误报成图标。
   *   现在必须排除气泡文案。
   */
  const bars = reportToolbar(pid)
  const iconLine = bars
    .split('\n')
    .filter(Boolean)
    .find((l) => /ToolbarActionView/i.test(l) && /harbor/i.test(l) && !/希望访问|边栏体验|访问此站点/.test(l))
  const bubble = bars.split('\n').some((l) => /Harbor/.test(l) && /希望访问|边栏体验/.test(l))
  if (iconLine) {
    console.log('  [现状] 工具栏上已有 Harbor 图标 —— 直接点它')
  } else {
    console.log('  [现状] 工具栏上没有 Harbor 图标 —— 先点「扩展」按钮（拼图），再在列表里点 Harbor')
    if (bubble) console.log('        （旁边那个「Harbor 希望访问此站点」是权限提示气泡，不是图标，点它没用）')
  }
  console.log('')

  /* 等用户点：harborInvoke 只有 action.onClicked 触发才写 */
  const started = Date.now()
  let invoked = null
  let ticks = 0
  while (Date.now() - started < TIMEOUT * 1000) {
    const got = await swEval(extId, 'chrome.storage.local.get("harborInvoke")')
    const v = got && got.value && got.value.harborInvoke
    if (v && typeof v === 'object' && Number(v.at) > 0) {
      invoked = v
      break
    }
    ticks += 1
    if (ticks % 10 === 0) {
      const left = Math.round((TIMEOUT * 1000 - (Date.now() - started)) / 1000)
      console.log(`  …还在等（剩 ${left}s）`)
    }
    await sleep(700)
  }

  console.log('\n──────── 判据 ────────')
  rec('① 你点了 Harbor 的扩展图标（action.onClicked 被触发）', Boolean(invoked), invoked ? `at=${new Date(invoked.at).toISOString()}` : '超时没等到')

  if (invoked) {
    rec('② 侧栏开着（action 回调里 sidePanel.open 成功）', invoked.opened === true, invoked.openErr || 'opened=true')
    rec(
      '③ ★ activeTab 已授予（点图标才会给）',
      invoked.hasUrl === true && /^https?:/.test(String(invoked.url || '')),
      `hasUrl=${invoked.hasUrl} url=${String(invoked.url || '').slice(0, 80)}`,
    )
    rec('④ 授予的那个标签就是我们打开的页面', String(invoked.url || '').includes('example.com'), String(invoked.url || ''))

    /* 找侧栏 target：扩展的 page target 里，宽度窄的就是侧栏 */
    await sleep(1500)
    const targets = (await (await fetch(`http://127.0.0.1:${PORT_EDGE}/json/list`)).json()).filter(
      (t) => t.type === 'page' && String(t.url || '').includes(extId),
    )
    let panel = null
    for (const t of targets) {
      const c = await EP.connect(t.webSocketDebuggerUrl)
      const probe = JSON.parse(
        String(
          (await c.evalIn(
            `JSON.stringify({ w: window.innerWidth, composer: !!document.querySelector('[aria-label="消息输入框"]'), read: !!document.querySelector('[aria-label="读当前页"]') })`,
          )) || '{}',
        ),
      )
      if (Number(probe.w) > 0 && Number(probe.w) < 500 && probe.composer) {
        panel = { conn: c, probe }
        break
      }
      c.close()
    }
    rec('⑤ ★ 侧栏真的出现了（窄面板 + Harbor 自己的输入框）', Boolean(panel), panel ? `innerWidth=${panel.probe.w}` : `扩展页 target ${targets.length} 个都不是侧栏`)
    rec('⑥ 侧栏里有「读当前页」按钮', Boolean(panel && panel.probe.read))

    /*
     * ⑦ 验的**不是**「Harbor 收下了」（那需要主进程在跑，本脚本没起桥），而是
     *    **activeTab 链路本身**：点图标才授予 activeTab → 才能拿 url、才能注入。
     */
    if (panel) {
      await fetch(`http://127.0.0.1:${PORT_EDGE}/json/activate/${page.id}`).catch(() => {})
      await sleep(600)
      await panel.conn.evalIn(`(function(){const b=document.querySelector('[aria-label="读当前页"]'); if(b) b.click(); return !!b})()`)
      await sleep(3500)
      const last = await swEval(extId, 'chrome.storage.local.get("harborLastPage")')
      const lp = last && last.value && last.value.harborLastPage
      rec(
        '⑦ ★★ activeTab 链路通了：拿到了用户页面的 url 且读到正文',
        Boolean(lp && String(lp.url || '').includes('example.com') && Number(lp.chars) > 0),
        lp ? `url=${String(lp.url || '').slice(0, 60)} chars=${lp.chars}` : '没有结果（读当前页可能压根没执行）',
      )
      rec(
        '⑧ 读到的正文不是空的（executeScript 真注入成功）',
        Boolean(lp && Number(lp.chars) > 100),
        lp ? `chars=${lp.chars}` : '无',
      )
      panel.conn.close()
    }
  }

  D.killEdge(pid)
  await sleep(800)
  D.removeProfile(profile)

  console.log(`\n════ 通过 ${pass} 项，失败 ${failures.length} 项 ════`)
  for (const f of failures) console.log('   ✗ ' + f)
  console.log('\n（本脚本用**产品 manifest**，没有加 host_permissions —— 所以 ⑦ 过了，就说明真实用户的权限链路是通的。）')
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.log('ERROR:', e && e.message)
  process.exit(1)
})
