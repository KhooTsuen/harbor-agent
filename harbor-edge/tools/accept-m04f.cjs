/**
 * 本批真机验收：**工具能被调用**（`tools.execute('edge_*')`）+ M04/M05 补齐的动作
 *
 * ── 这一条为什么最重要 ────────────────────────────────────────
 *
 * 上几批做的能力（click / type / … / tabs）只有 `accept-*.cjs` 能调 —— 模型在对话里
 * **调不到**（工具表里没有）。本批把它们接成工具后，**唯一算数的判据**就是：
 * 从 `tools.execute(name, args, ctx)` 进去，走完权限门 / 审计 / 真链路，拿回结果。
 *
 * 所以本脚本**不直调 extCommand**（那是 m04b/m04d 干的事），一律走 `tools.execute`。
 *
 * 隔离：独立 profile / 隔离数据根 / 注册表快照→恢复 / 跑完删 profile 与副本。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const D = require('../lib/driver.cjs')
const S = require('../lib/ext-stage.cjs')

const ROOT = S.ROOT
const ISO = path.join(ROOT, 'data', 'unit-test-data')
const HOST_NAME = 'com.harbor.agent'
const PORT_EDGE = 9351
const PORT_PAGE = 8861
const PROFILE = 'profile-m04f'
const DIST = path.join(ROOT, 'harbor-edge', 'dist', 'sidepanel')
const STAGE = path.join(ISO, 'm04f-ext')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass: Boolean(pass) })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  -- ${detail ?? ''}`)
}

/* ── 测试页：输入框 / 密码框 / 下拉框 / 提交按钮 / 只读按钮 / 可滚动 ── */
const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>工具验收页</title></head>
<body style="height:2400px;margin:0">
<h1>工具验收页</h1>
<form method="post" action="/submitted">
  <input id="name" placeholder="你的名字">
  <input id="pwd" type="password" value="secret123" placeholder="密码">
  <input id="cc" autocomplete="cc-number" placeholder="卡号">
  <select id="pick"><option value="a">甲</option><option value="b">乙</option><option value="c">丙</option></select>
  <button id="submit" type="submit">提交订单</button>
</form>
<button id="plain" type="button" onclick="document.getElementById('out').textContent='已看详情'">看详情</button>
<div id="out">初始</div>
</body></html>`

const servers = []
const serverErrors = []
function serve(port, html) {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      req.url === '/submitted'
        ? '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>已提交</title></head><body><h1>已提交</h1><p>表单提交后的页面</p></body></html>'
        : html,
    )
  })
  s.on('error', (e) => serverErrors.push(`端口 ${port}：${e.message}`))
  s.listen(port, '127.0.0.1')
  servers.push(s)
  return s
}

async function waitPort(port, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' })
      if (r.ok || r.status === 200 || r.status === 404) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  return false
}

let edge = null
/** 注册表真原值（外部备份，见 lib/ext-stage.cjs 的文件头）—— 必须在 regDel 之前取 */
const regSnapshot = S.snapshotRegistry(HOST_NAME)
/** 装好的隔离 host（finally 里要清） */
let staged = null

async function main() {
  serve(PORT_PAGE, PAGE)
  const pageOk = (await waitPort(PORT_PAGE)) && serverErrors.length === 0
  rec('① 测试页起来了', pageOk, serverErrors.join(' | ') || `:${PORT_PAGE}`)
  if (!pageOk) return false

  /*
   * ── 本进程起桥 + 真 extCommand（**脚本化的用户**：确认卡自动答）──
   * 敏感确认卡走 `confirm` 依赖（M04 那条），这里给一个可按需切换答案的假用户。
   */
  process.env.HARBOR_UNIT_TEST = '1'
  const B = require(path.join(ROOT, 'electron/core/ext-bridge.cjs'))
  const EC = require(path.join(ROOT, 'electron/core/ext-command.cjs'))
  const tools = require(path.join(ROOT, 'electron/core/tools/index.cjs'))
  const session = require(path.join(ROOT, 'electron/core/session.cjs'))
  const audit = require(path.join(ROOT, 'electron/core/audit.cjs'))
  const { wrapWebText } = require(path.join(ROOT, 'electron/core/tools/_web-note.cjs'))

  const asked = []
  let allowConfirm = false
  const bridge = B.createBridge()
  const command = EC.createCommand({
    getBridge: () => bridge,
    log: { info: () => {}, warn: (m) => console.log('   [指令!]', m) },
    land: (kind, result, meta) => bridge.landAction(kind, result, meta),
    confirm: async (request) => {
      asked.push(request)
      console.log('   [确认卡]', request?.summary ?? request?.title ?? '(无摘要)')
      return allowConfirm
    },
  })
  bridge.start({
    dataDir: ISO,
    send: () => {},
    session,
    audit,
    wrap: wrapWebText,
    log: { info: (m) => console.log('   [桥]', m), warn: (m) => console.log('   [桥!]', m) },
    command,
  })
  /* ★ 把它交给 handlers/ext.cjs —— 工具就是从这里拿到**同一个**实例的 */
  require(path.join(ROOT, 'electron/handlers/ext.cjs')).setCommand(command)

  /* tools.execute 的 ctx：完全访问档（不弹风险框）；confirm 记数用来看「有没有被问」 */
  let riskAsked = 0
  const ctx = {
    workdir: ISO,
    sessionId: 'sess_m04f',
    taskId: 'task_m04f',
    permission: 'full',
    allowTools: true,
    allowWrite: true,
    allowNetwork: true,
    outputLimit: 200000,
    granted: new Map(),
    log: { warn: () => {}, info: () => {} },
    confirm: async () => {
      riskAsked += 1
      return true
    },
  }
  const call = (name, args) => tools.execute(name, args ?? {}, ctx)

  /* ── 起 Edge（副本加 host_permissions）+ 装隔离 host ── */
  fs.rmSync(STAGE, { recursive: true, force: true })
  fs.cpSync(DIST, STAGE, { recursive: true })
  const mf = path.join(STAGE, 'manifest.json')
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'))
  m.host_permissions = ['http://127.0.0.1/*']
  fs.writeFileSync(mf, JSON.stringify(m, null, 2))

  S.regDel(HOST_NAME)
  edge = await D.launchEdge({ profileName: PROFILE, port: PORT_EDGE, extDir: STAGE, waitMs: 2500 })
  rec('② Edge 起来了（隔离 profile）', edge.ready === true, `pid=${edge.child.pid}`)
  let extId = null
  for (let i = 0; i < 40 && !extId; i += 1) {
    await sleep(500)
    extId = D.readExtIdFromProfile(edge.profile, STAGE)
  }
  rec('③ 真扩展被加载（副本，带 host_permissions）', Boolean(extId), String(extId))
  if (!extId) return false

  staged = S.stageHost({ dataDir: ISO, extId, name: HOST_NAME, tag: 'm04f' })
  /* host stderr 落盘（诊断用） */
  try {
    const src = fs.readFileSync(staged.cmd, 'utf8')
    fs.writeFileSync(staged.cmd, src.replace(/(Harbor\.exe"?\s+"[^"]+")/, `$1 2>"${path.join(ISO, 'm04f-host.err')}"`), 'ascii')
  } catch {
    /* 少了诊断不致命 */
  }
  rec('④ 装好隔离 host', fs.existsSync(staged.cmd), staged.cmd)

  const pageTab = await D.openTab(PORT_EDGE, `http://127.0.0.1:${PORT_PAGE}/`)
  await sleep(800)
  const panel = await D.openTab(PORT_EDGE, `chrome-extension://${extId}/index.html`)
  await sleep(600)
  const activate = (id) => fetch(`http://127.0.0.1:${PORT_EDGE}/json/activate/${id}`).catch(() => {})
  await activate(pageTab.target.id)

  /* 等扩展连上（host 启动即连 —— 判据 ⑥ 在 m04c 已单验，这里只等就绪） */
  let conn = 0
  for (let i = 0; i < 30; i += 1) {
    await sleep(500)
    try {
      conn = bridge.connectionCount()
    } catch {
      conn = 0
    }
    if (conn > 0) break
  }
  rec('⑤ 扩展连上 Harbor 的管道', conn > 0, `连接数=${conn}`)
  if (!conn) return false

  /* ══ ⑥ 工具能被调用：edge_page（读元素）══ */
  const r1 = await call('edge_page', {})
  const ver1 = (String(r1).match(/页面版本[：:]\s*([0-9a-f]+)/) ?? [])[1] ?? ''
  rec('⑥ ★★ 从 tools.execute 调 edge_page（这才是「能被调用」）', /页面元素/.test(r1) && Boolean(ver1), ver1 || r1.slice(0, 80))
  /* 从渲染出的表格里抠引用：列顺序是 | # | 角色 | 文本 | 状态 | 引用 | */
  const rows = String(r1)
    .split('\n')
    .filter((l) => /^\|\s*\d+\s*\|/.test(l))
  const refOfRow = (l) => (l ? (l.split('|').map((s) => s.trim())[5] ?? '') : '')
  const byLabel = (kw) => refOfRow(rows.find((l) => l.includes(kw)))
  /* ★ 敏感字段的文本列是「（敏感字段，不读取）」抠不到 → 按 textbox 行的**顺序**取 */
  const tbRows = rows.filter((l) => l.includes('textbox'))
  const refName = refOfRow(tbRows[0])
  const refPwd = refOfRow(tbRows[1])
  const refCc = refOfRow(tbRows[2])
  const refSelect = refOfRow(rows.find((l) => /select|combobox/.test(l)))
  const refSubmit = byLabel('提交订单')
  const refPlain = byLabel('看详情')
  rec(
    '⑥ 抠到输入框 / 密码框 / 下拉框 / 提交按钮的引用',
    Boolean(refName && refPwd && refCc && refSelect && refSubmit && refPlain),
    `${refName} / ${refSubmit} / ${refPlain}`,
  )

  /* ══ ⑦ edge_type：真填进去 + 密码卡被拒 ══ */
  const t1 = await call('edge_type', { ref: refName, text: '张三' })
  const v1 = String(await pageTab.evalIn(`(document.getElementById('name')||{}).value || ''`))
  rec('⑦ ★★ 工具 edge_type 真把值写进页面', v1 === '张三', `"${v1}"`)
  const t2 = await call('edge_type', { ref: refPwd, text: 'hacked' })
  const v2 = String(await pageTab.evalIn(`(document.getElementById('pwd')||{}).value || ''`))
  rec('⑦ ★★ 密码框被拒（工具返回里明说）', /拒绝执行/.test(t2) && /页面没有被改动/.test(t2), t2.slice(0, 60).replace(/\n/g, ' '))
  rec('⑦ ★★ 密码框的值一个字没变', v2 === 'secret123', `"${v2}"`)
  const t3 = await call('edge_type', { ref: refCc, text: '4111111111111111' })
  const v3 = String(await pageTab.evalIn(`(document.getElementById('cc')||{}).value || ''`))
  rec('⑦ ★★ 信用卡字段也被拒', /拒绝执行/.test(t3) && v3 === '', t3.slice(0, 50).replace(/\n/g, ' '))

  /* ══ ⑧ clear / focus / key（M04 补齐）══ */
  const c1 = await call('edge_type', { ref: refName, text: '再填一次' })
  rec('⑧ ★ edge_type 传文本正常（下面清空要用同一个引用）', /填写文本/.test(c1), c1.split('\n')[1] ?? '')
  const clr = await call('edge_type', { ref: refName })
  console.log('  [诊断] 清空返回 =', JSON.stringify(clr).slice(0, 200))
  const v4 = String(await pageTab.evalIn(`(document.getElementById('name')||{}).value || ''`))
  rec('⑧ ★ 「不填 text」= 清空（工具层没有 edge_clear —— 不新增语义重复的工具）', v4 === '' && /填写文本/.test(clr), JSON.stringify(v4))

  /* clear 是 ext-command 的方法（工具层没有单列：type 空串就是清空）—— 这里验它确实存在 */
  const clrCmd = await command.clear({ ref: refName })
  rec('⑧ ★ ext-command.clear 通了（工具没有 edge_clear —— 语义重复的工具只会让模型犹豫）', clrCmd && clrCmd.ok === true, String(clrCmd && clrCmd.ok))

  const f1 = await call('edge_focus', { ref: refName })
  const activeId = String(await pageTab.evalIn(`(document.activeElement||{}).id || ''`))
  rec('⑧ ★★ edge_focus 真的把焦点给了那个框', activeId === 'name' && /聚焦/.test(f1), `activeElement=#${activeId}`)

  const k1 = await call('edge_key', { key: 'Enter', ref: refName })
  rec('⑧ ★★ edge_key 派发了三种键盘事件', /按键/.test(k1) && /派发给/.test(k1), k1.split('\n').find((l) => l.includes('键')) ?? '')

  /* ══ ⑨ 敏感确认：提交按钮先问；拒绝不点 ══ */
  allowConfirm = false
  const askedBefore = asked.length
  const s1 = await call('edge_click', { ref: refSubmit })
  rec('⑨ ★★ 提交类按钮 → 先弹确认卡（没直接点）', asked.length > askedBefore, `问了 ${asked.length - askedBefore} 次`)
  rec('⑨ ★★ 拒绝 → 明确说「没点、页面没被改动」', /取消|没有点击|没点/.test(s1), s1.slice(0, 70).replace(/\n/g, ' '))
  const urlAfterDeny = String(await pageTab.evalIn('location.href'))
  rec('⑨ ★★ 拒绝后页面**没被提交**（url 没变）', !/submitted/.test(urlAfterDeny), urlAfterDeny)

  /* 普通按钮（type=button）不该问 */
  const askedBefore2 = asked.length
  const s2 = await call('edge_click', { ref: refPlain })
  const outText = String(await pageTab.evalIn(`(document.getElementById('out')||{}).textContent || ''`))
  rec('⑨ ★ 只读按钮（type=button）**不弹卡**、直接点到', asked.length === askedBefore2 && outText === '已看详情', `asked=${asked.length - askedBefore2} out=${outText}`)

  /* 允许 → 真提交（页面导航到 /submitted） */
  await activate(pageTab.target.id)
  const cur = await call('edge_page', {})
  const submitRef2 = (() => {
    const rows2 = String(cur).split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l) && l.includes('提交订单'))
    const cells = rows2[0] ? rows2[0].split('|').map((s) => s.trim()) : []
    return cells.length >= 6 ? cells[5] : ''
  })()
  allowConfirm = true
  const s3 = await call('edge_click', { ref: submitRef2 })
  await sleep(1200)
  const urlSubmitted = String(await pageTab.evalIn('location.href'))
  rec(
    '⑨ ★★ 允许 → 才真的点（真提交，地址变成 /submitted）',
    /submitted/.test(urlSubmitted),
    `${urlSubmitted} · ${String(s3).slice(0, 40).replace(/\n/g, ' ')}`,
  )

  /* ══ ⑩ edge_wait（立刻验一次 = verify）══ */
  const w1 = await call('edge_wait', { expect: { text: '已提交' }, timeoutMs: 0 })
  rec('⑩ ★★ edge_wait（timeoutMs=0）就是「现在验一次」', /条件满足了/.test(w1), w1.split('\n')[1] ?? '')
  const w2 = await call('edge_wait', { expect: { text: '页面上绝对没有的串' }, timeoutMs: 600 })
  rec('⑩ ★ 等不到 → 如实说「没变成你等的那个样子」（不是报错）', /条件一直没满足|没变成你等的/.test(w2), '')

  /* ══ ⑪ M05 补齐：新建 / 关闭标签页 ══ */
  const tcreate = await call('edge_tabs', { action: 'create', url: `http://127.0.0.1:${PORT_PAGE}/` })
  const tl = await call('edge_tabs', { action: 'list' })
  const newId = (String(tcreate).match(/已新建标签\s*(\d+)/) ?? [])[1] ?? ''
  rec('⑪ ★★ edge_tabs create 新建了标签（回读拿到 id）', Boolean(newId), newId || tcreate.slice(0, 60).replace(/\n/g, ' '))
  rec('⑪ ★ 新建的标签出现在 list 里', Boolean(newId) && String(tl).includes(newId), '')

  const tclose = await call('edge_tabs', { action: 'close', id: Number(newId) })
  const tl2 = await call('edge_tabs', { action: 'list' })
  rec('⑪ ★★ edge_tabs close 关掉了（回读确认不在列表里）', /已关闭/.test(tclose) && !String(tl2).includes(`| ${newId} |`), tclose.split('\n')[1] ?? '')
  const tbad = await call('edge_tabs', { action: 'close', id: 999999999 })
  rec('⑪ ★★ 编一个不存在的 id → 拒绝（不瞎关）', /错误|不在能操作的列表/.test(tbad), String(tbad).slice(0, 70))

  /* ══ ⑫ 风险档：edge 工具**没弹风险框**（用户拍板「只在敏感动作确认」）══ */
  rec('⑫ ★★ 全程 edge 工具**没有**触发风险确认框（只有敏感卡）', riskAsked === 0, `riskAsked=${riskAsked}`)

  /* ══ ⑬ 只分析档：edge 写类被拦 ══ */
  const ro = await tools.execute('edge_click', { ref: refName }, { ...ctx, allowWrite: false })
  rec('⑬ ★★ 「只分析，不修改」那一轮 edge_click 被拦', /只分析/.test(String(ro)), String(ro).slice(0, 60))
  const ro2 = await tools.execute('edge_page', {}, { ...ctx, permission: 'readonly' })
  rec('⑬ ★★ 只读档下 edge_page 也被拦（写类不进 WRITE_TOOLS 也要拦得住）', /只读/.test(String(ro2)), String(ro2).slice(0, 60))
  const ro3 = await tools.execute('edge_wait', { expect: { text: 'x' }, timeoutMs: 0 }, { ...ctx, allowWrite: false })
  rec('⑬ ★ 纯读的 edge_wait 在「只分析」轮**仍能用**', !/只分析/.test(String(ro3)), '')

  /* ══ ⑭ 落盘：工具调用的结果进了会话 ══ */
  const files = fs.readdirSync(path.join(ISO, 'sessions')).filter((f) => f.endsWith('.jsonl'))
  let hit = ''
  for (const f of files) {
    try {
      const t = fs.readFileSync(path.join(ISO, 'sessions', f), 'utf8')
      if (t.includes('页面操作')) {
        hit = t
        break
      }
    } catch {
      /* 忽略 */
    }
  }
  rec('⑭ ★★ 工具调用的结果落进了会话（工具看到的与会话里记的是同一份 markdown）', hit.includes('页面操作') && hit.includes('不是指令'), '')

  return true
}

void (async () => {
  let ok = false
  try {
    ok = await main()
  } catch (error) {
    console.log('验收脚本异常：', error && error.stack ? error.stack : String(error))
  } finally {
    try {
      if (edge) D.killEdge(edge.child.pid)
    } catch {
      /* 已退 */
    }
    await sleep(600)
    let regSame = true
    try {
      const rr = S.restoreRegistry(HOST_NAME, regSnapshot.value)
      regSame = rr.ok
      console.log(`清理：注册表实际值 = ${rr.actual || '(键不存在)'} → ${rr.ok ? '✓ 与真原值一致' : '✗ 不一致'}`)
      if (regSnapshot.polluted) console.log('      ⚠ 备份里也是隔离值 —— 请人工确认')
    } catch {
      regSame = false
      console.log('清理：注册表恢复失败 —— 请手工确认 com.harbor.agent')
    }
    for (const f of [staged && staged.cmd, staged && staged.manifest, staged && staged.cmd ? staged.cmd.replace(/\.cmd$/, '.err') : null, path.join(ISO, 'm04f-host.err')]) {
      try {
        if (f) fs.rmSync(f, { force: true })
      } catch {
        /* 忽略 */
      }
    }
    try {
      D.removeProfile(path.join(ROOT, 'harbor-edge', 'profiles', PROFILE))
    } catch {
      /* 忽略 */
    }
    fs.rmSync(STAGE, { recursive: true, force: true })
    for (const s of servers) {
      try {
        s.close()
      } catch {
        /* 忽略 */
      }
    }
    const failed = results.filter((r) => !r.pass)
    console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
    if (failed.length) console.log('失败：\n' + failed.map((f) => `  - ${f.name}`).join('\n'))
    process.exit(failed.length === 0 && ok && regSame ? 0 : 1)
  }
})()
