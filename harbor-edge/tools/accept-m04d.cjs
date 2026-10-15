/**
 * M04 剩余 + M05 真机验收：**type / select / scroll / wait / navigate / 敏感确认 / tabs 三件**
 *
 * 链路全真：验收进程里的 `ext-command`（真）--push--> 真命名管道 → 真 native host
 *   → 真 Edge + 真扩展（副本，带 host_permissions）→ 真 `chrome.scripting.executeScript`
 *   → 真页面 DOM → 真回执 → 落盘（真 session / 真 audit）。
 *
 * ★ 分三段：
 *   A 填表与确认（真页面：输入框 / 密码框 / 下拉框 / 提交按钮）
 *   B 滚动 / 等待 / 导航
 *   C 标签页三件（真开 3 个标签）
 *
 * 隔离：独立 profile / 隔离数据根 / 注册表**快照→恢复→回读比对** / 跑完删副本与 profile。
 * ★ 复本加 `host_permissions` 的理由见 accept-m04a 的文件头（产品 manifest 刻意不加）。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawnSync } = require('node:child_process')

const D = require('../lib/driver.cjs')
const P = require('../lib/ext-probe.cjs')
const S = require('../lib/ext-stage.cjs')

const ROOT = S.ROOT
const ISO = path.join(ROOT, 'data', 'unit-test-data')
const CONF = path.join(ISO, 'config.json')
const CRED = path.join(ISO, 'credentials.json')
const HOST_NAME = 'com.harbor.agent'
const PORT_EDGE = 9344
const PORT_PAGE = 8841
const PROFILE = 'profile-m04d'
const DIST = path.join(ROOT, 'harbor-edge', 'dist', 'sidepanel')
const STAGE = path.join(ISO, 'm04d-ext')

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  -- ${detail}`)
}
const sleep = P.sleep
const file = (p, fb = '') => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return fb
  }
}

/* ── 隔离数据 ── */
const confBackup = fs.existsSync(CONF) ? fs.readFileSync(CONF, 'utf8') : null
const credBackup = fs.existsSync(CRED) ? fs.readFileSync(CRED, 'utf8') : null
const restoreData = () => {
  try {
    if (confBackup === null) fs.rmSync(CONF, { force: true })
    else fs.writeFileSync(CONF, confBackup)
    if (credBackup === null) fs.rmSync(CRED, { force: true })
    else fs.writeFileSync(CRED, credBackup)
  } catch {
    /* 忽略 */
  }
}
fs.mkdirSync(ISO, { recursive: true })
const baseCfg = JSON.parse(file(path.join(ROOT, 'data', 'config.json'), '{}') || '{}')
if (baseCfg.providers && baseCfg.providers[0]) baseCfg.providers[0].baseUrl = `http://127.0.0.1:${PORT_PAGE}/v1`
if (baseCfg.general) baseCfg.general.defaultWorkdir = path.join(ISO, 'chat')
fs.writeFileSync(CONF, JSON.stringify(baseCfg, null, 2))
fs.writeFileSync(CRED, JSON.stringify({ version: 1, backend: 'plain', entries: { 'provider:deepseek': { key: 'sk-fake' } } }))

/* ── 注册表真原值（外部备份，见 ext-stage 文件头）── */
const regSnap = S.snapshotRegistry(HOST_NAME)

/* ── 副本：加 host_permissions（只在副本里）── */
fs.rmSync(STAGE, { recursive: true, force: true })
fs.cpSync(DIST, STAGE, { recursive: true })
const mf = path.join(STAGE, 'manifest.json')
const m0 = JSON.parse(fs.readFileSync(mf, 'utf8'))
m0.host_permissions = ['http://127.0.0.1/*']
fs.writeFileSync(mf, JSON.stringify(m0, null, 2))

/* ── 测试页（可交互元素 / 密码框 / 下拉框 / 提交按钮 / 高页面用于滚动）── */
const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>M04 剩余验收页</title></head><body>
<h1>M04 剩余验收页</h1>
<form id="f1" method="post" action="/submitted">
  <input id="name" name="name" placeholder="你的名字">
  <input id="pwd" type="password" name="password" value="secret123" placeholder="密码">
  <input id="cc" name="card" autocomplete="cc-number" placeholder="卡号">
  <select id="sel"><option value="a">甲</option><option value="b">乙</option><option value="c">丙</option></select>
  <button id="sub" type="submit">提交订单</button>
  <button id="plain" type="button">看详情</button>
</form>
<div id="pad" style="height:2000px"></div>
<p id="bottom">到底了</p>
</body></html>`

const servers = []
const serverErrors = []
function serve(port, html) {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  s.on('error', (e) => serverErrors.push(`端口 ${port} 起不来：${e.message}`))
  s.listen(port, '127.0.0.1')
  servers.push(s)
  return s
}

/** 等端口真的在听（带超时 —— 用户不在时不能挂死） */
async function waitPort(port, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    try {
      /* eslint-disable-next-line no-await-in-loop */
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
const procs = []

async function main() {
  serve(PORT_PAGE, PAGE)
  const pageOk = (await waitPort(PORT_PAGE)) && serverErrors.length === 0
  rec('① 测试页服务起来了', pageOk, serverErrors.length ? serverErrors.join(' | ') : `:${PORT_PAGE}`)
  if (!pageOk) return false

  /* ── 本进程起桥（真管道）+ 真 ext-command（含敏感确认：这里用**脚本化的用户**）── */
  process.env.HARBOR_UNIT_TEST = '1'
  const B = require(path.join(ROOT, 'electron/core/ext-bridge.cjs'))
  const EC = require(path.join(ROOT, 'electron/core/ext-command.cjs'))
  const session = require(path.join(ROOT, 'electron/core/session.cjs'))
  const audit = require(path.join(ROOT, 'electron/core/audit.cjs'))
  const { wrapWebText } = require(path.join(ROOT, 'electron/core/tools/_web-note.cjs'))

  const asked = []
  let allowConfirm = false
  const bridge = B.createBridge()
  const command = EC.createCommand({
    getBridge: () => bridge,
    log: { info: (m) => console.log('   [指令]', m), warn: (m) => console.log('   [指令!]', m) },
    land: (kind, result, meta) => bridge.landAction(kind, result, meta),
    confirm: async (request, meta) => {
      asked.push({ request, meta })
      console.log(`   [确认卡] ${request.summary} · 影响 ${request.impact.length} 条`)
      return allowConfirm
    },
  })
  const started = bridge.start({
    dataDir: ISO,
    send: () => {},
    session,
    audit,
    wrap: wrapWebText,
    log: { info: (m) => console.log('   [桥]', m), warn: (m) => console.log('   [桥!]', m) },
    command,
  })
  rec('② 验收进程里的桥起来了（真管道）', started.ok === true, started.name)
  if (!started.ok) return false

  S.regDel(HOST_NAME)
  edge = await D.launchEdge({ profileName: PROFILE, port: PORT_EDGE, extDir: STAGE, waitMs: 2500 })
  rec('③ Edge 起来了（隔离 profile）', edge.ready === true, `pid=${edge.child.pid}`)
  let extId = null
  for (let i = 0; i < 40 && !extId; i += 1) {
    await sleep(500)
    extId = D.readExtIdFromProfile(edge.profile, STAGE)
  }
  rec('④ 真扩展被加载（副本，带 host_permissions）', Boolean(extId), String(extId))

  const staged = S.stageHost({ dataDir: ISO, extId, name: HOST_NAME, tag: 'm04d' })
  rec('⑤ 装好隔离 host', fs.existsSync(staged.cmd), staged.cmd)
  await sleep(3500)

  /* ── 打开测试页 + 侧边栏（**测试页在前台**：SW 只动前台标签）── */
  const pageTab = await D.openTab(PORT_EDGE, `http://127.0.0.1:${PORT_PAGE}/`)
  await sleep(1200)
  const panel = await D.openTab(PORT_EDGE, `chrome-extension://${extId}/index.html`)
  await sleep(1200)
  const activate = (id) => fetch(`http://127.0.0.1:${PORT_EDGE}/json/activate/${id}`).catch(() => {})
  await activate(pageTab.target.id)
  await sleep(600)
  const val = (sel) => pageTab.evalIn(`(function(){const e=document.querySelector(${JSON.stringify(sel)});return e?String(e.value):'__none__'})()`)

  /* ══ A 段：type（含拒密码）/ select / 敏感确认 ══ */
  const els = await command.getElements({})
  if (!els || els.ok !== true) {
    rec('⑥ 拿元素列表（后续判据的前提）', false, JSON.stringify(els && els.error))
    return false
  }
  const refOf = (pred) => ((els.elements ?? []).find(pred) ?? {}).ref ?? ''
  const nameRef = refOf((e) => e.tag === 'INPUT' && /名字/.test(String(e.placeholder)))
  const pwdRef = refOf((e) => e.masked === true || /密码/.test(String(e.placeholder)))
  const ccRef = refOf((e) => String(e.placeholder) === '卡号')
  const selRef = refOf((e) => e.tag === 'SELECT')
  const subRef = refOf((e) => /提交/.test(String(e.text)))
  const plainRef = refOf((e) => /看详情/.test(String(e.text)))

  /* ── ⑥ type 正常 ── */
  const before = await val('#name')
  const t1 = await command.type({ ref: nameRef, text: '张三' })
  const after = await val('#name')
  rec('⑥ ★ type 填进去了（页面 value 真的变了）', t1.ok === true && after === '张三' && before !== after, `${JSON.stringify(before)} → ${JSON.stringify(after)}`)
  rec('⑥ ★ 证据里带 value 前后值', Boolean(t1.result && t1.result.evidence && t1.result.evidence.valueBefore === before), JSON.stringify(t1.result && t1.result.evidence))

  /* ── ⑦ ★ 密码框：拒绝 + 页面未被改动 ── */
  const pwdBefore = await val('#pwd')
  const t2 = await command.type({ ref: pwdRef, text: 'hunter2' })
  const pwdAfter = await val('#pwd')
  const t2why = String((t2.result && t2.result.reason) || (t2.error && t2.error.code) || '')
  rec('⑦ ★★ 密码框被**拒绝**（sensitive-field）', t2.ok === false && t2why === 'sensitive-field', t2why)
  rec('⑦ ★★ 拒绝后**页面里的值一个字没变**', pwdAfter === pwdBefore, `${JSON.stringify(pwdBefore)} → ${JSON.stringify(pwdAfter)}`)
  rec('⑦ 人话里说清「页面没有被改动」', /页面没有被改动/.test(String(t2.result && t2.result.message)) || /页面没有被改动/.test(String(t2.error && t2.error.message)))

  /* ── ⑧ ★ 信用卡字段：同样拒绝 ── */
  const ccBefore = await val('#cc')
  const t3 = await command.type({ ref: ccRef, text: '4111111111111111' })
  const ccAfter = await val('#cc')
  const t3why = String((t3.result && t3.result.reason) || (t3.error && t3.error.code) || '')
  rec('⑧ ★★ 信用卡字段也被拒（cc-*）', t3.ok === false && t3why === 'sensitive-field', t3why + ' · field=' + String(t3.result && t3.result.field))
  rec('⑧ ★ 拒了之后卡号没进页面', ccAfter === ccBefore, `${JSON.stringify(ccBefore)} → ${JSON.stringify(ccAfter)}`)

  /* ── ⑨ select ── */
  const sBefore = await val('#sel')
  const s1 = await command.select({ ref: selRef, value: 'c' })
  const sAfter = await val('#sel')
  rec('⑨ ★ select 选中了（页面 select.value 真的变了）', s1.ok === true && sAfter === 'c' && sBefore !== sAfter, `${JSON.stringify(sBefore)} → ${JSON.stringify(sAfter)}`)
  const s2 = await command.select({ ref: selRef, label: '乙' })
  console.log('  [诊断] select(label) 返回 =', JSON.stringify(s2).slice(0, 300))
  rec('⑨ ★ 按 label 也能选（乙 → value=b）', s2.ok === true && (await val('#sel')) === 'b', JSON.stringify(s2.result && s2.result.selected))
  const s3 = await command.select({ ref: selRef, value: '不存在' })
  console.log('  [诊断] select(不存在) 返回 =', JSON.stringify(s3).slice(0, 400))
  rec('⑨ ★ 找不到的选项 → 如实说 + 列出可选值', Boolean(s3.result && Array.isArray(s3.result.options) && s3.result.options.length === 3), JSON.stringify((s3.result && s3.result.options) || []))

  /* ── ⑩ ★★ 提交按钮 → 弹确认卡；拒绝 → 没提交 ── */
  console.log('  [诊断] 提交按钮那条记录 =', JSON.stringify((els.elements ?? []).find((e) => /提交/.test(String(e.text)))))
  console.log('  [诊断] 原始 elements 前两条 =', JSON.stringify((els.elements ?? []).slice(0, 2)))
  asked.length = 0
  allowConfirm = false
  const c1 = await command.click({ ref: subRef })
  console.log('  [诊断] click(提交) 返回 =', JSON.stringify(c1).slice(0, 500))
  const urlAfterDeny = String(await pageTab.evalIn('location.href'))
  rec('⑩ ★★ 点「提交订单」→ **先弹了确认卡**（没直接点）', asked.length === 1, `asked=${asked.length}`)
  rec('⑩ ★ 卡里有页面 + 元素 + 后果（不写空话）', asked.length === 1 && asked[0].request.impact.length >= 3, JSON.stringify((asked[0] && asked[0].request.impact) || []).slice(0, 160))
  rec('⑩ ★★ 用户拒绝 → DENIED，且**页面没被提交**（url 没变）', c1.ok === false && String(c1.error && c1.error.code) === 'DENIED' && !/submitted/.test(urlAfterDeny), urlAfterDeny)

  /* ── ⑪ 普通按钮 → 不该问 ── */
  asked.length = 0
  allowConfirm = true
  const c2 = await command.click({ ref: plainRef })
  rec('⑪ ★ 普通按钮（看详情）**不弹卡**，直接点', asked.length === 0 && c2.ok === true, `asked=${asked.length}`)

  /* ── ⑫ 允许 → 真的点下去（提交生效）── */
  asked.length = 0
  allowConfirm = true
  await pageTab.evalIn(`(function(){document.getElementById('f1').addEventListener('submit',function(e){e.preventDefault();document.title='已提交'})})()`)
  const c3 = await command.click({ ref: subRef, settleMs: 600 })
  await sleep(600)
  rec('⑫ ★★ 用户允许 → 才真的点（提交生效：标题变了）', asked.length === 1 && c3.ok === true && String(await pageTab.evalIn('document.title')) === '已提交', `asked=${asked.length} title=${await pageTab.evalIn('document.title')}`)

  /* ══ B 段：scroll / wait / navigate ══ */
  const y0 = Number(await pageTab.evalIn('window.scrollY || 0'))
  const sc = await command.scroll({ to: 'bottom' })
  await sleep(300)
  const y1 = Number(await pageTab.evalIn('window.scrollY || 0'))
  rec('⑬ ★ scroll 到底（scrollY 从 0 变成 >0）', sc.ok === true && y1 > y0, `${y0} → ${y1}`)
  await command.scroll({ to: 'top' })
  await sleep(200)
  rec('⑬ ★ 能滚回去（top → 0）', Number(await pageTab.evalIn('window.scrollY || 0')) === 0, String(await pageTab.evalIn('window.scrollY || 0')))

  const w1 = await command.wait({ expect: { text: '一个绝对不存在的文本ABC' }, timeoutMs: 1500 })
  rec('⑭ ★ wait：等一个不存在的 → 超时但不是报错（matched=false）', w1.ok === true && w1.result.matched === false && w1.result.timedOut === true, `等了 ${w1.result.waitedMs}ms`)
  await pageTab.evalIn(`(function(){const d=document.createElement('p');d.id='late';d.textContent='后出现的文本XYZ';document.body.appendChild(d);return true})()`)
  const w2 = await command.wait({ expect: { selector: '#late', text: '后出现的文本XYZ' }, timeoutMs: 5000 })
  rec('⑭ ★★ wait：条件满足即返回（新元素出现）', w2.ok === true && w2.result.matched === true && w2.result.waitedMs < 4000, `等了 ${w2.result.waitedMs}ms · 查 ${w2.result.polls} 次`)

  const nv = await command.navigate({ url: `http://127.0.0.1:${PORT_PAGE}/next` })
  await sleep(800)
  const navUrl = String(await pageTab.evalIn('location.href'))
  rec('⑮ ★ navigate 到新地址（url 真的变了）', nv.ok === true && /\/next/.test(navUrl), navUrl)
  rec('⑮ ★ 证据里带 url 前后', Boolean(nv.result && nv.result.evidence && nv.result.evidence.urlChanged === true), JSON.stringify(nv.result && nv.result.evidence))

  /* ══ C 段：tabs 三件 ══ */
  const t2tab = await D.openTab(PORT_EDGE, `http://127.0.0.1:${PORT_PAGE}/p2`)
  await sleep(600)
  const t3tab = await D.openTab(PORT_EDGE, `http://127.0.0.1:${PORT_PAGE}/p3`)
  await sleep(600)
  await activate(pageTab.target.id)
  await sleep(400)

  const list = await command.tabsList()
  const tabs = (list.result && list.result.tabs) || []
  rec('⑯ ★★ tabs.list 列出多个标签（真开了 3+ 个）', list.ok === true && tabs.length >= 3, `条数=${tabs.length}`)
  rec('⑯ ★ 列出的每条有 id / 标题 / 地址', tabs.length > 0 && tabs.every((t) => typeof t.id === 'number' && 'url' in t), JSON.stringify(tabs.slice(0, 3)))

  const search = await command.tabsSearch({ query: '/p3' })
  const found = (search.result && search.result.tabs) || []
  rec('⑰ ★ tabs.search 按地址搜到那一条', search.ok === true && found.length >= 1 && found.some((t) => /p3/.test(String(t.url))), JSON.stringify(found.map((t) => t.url)))

  const targetId = Number((found[0] || {}).id)
  const act = await command.tabsActivate({ id: targetId })
  await sleep(500)
  const listAfter = await command.tabsList()
  const activeAfter = ((listAfter.result && listAfter.result.tabs) || []).find((t) => t.active === true)
  rec('⑱ ★★ tabs.activate 真的切过去了（回读：active 变成它）', act.ok === true && activeAfter && Number(activeAfter.id) === targetId, `想要 ${targetId} · 实际前台 ${activeAfter && activeAfter.id}`)

  const bad = await command.tabsActivate({ id: 999999 })
  rec('⑱ ★★ 编一个不存在的 id → 被拒（NO_TAB，防编 id）', bad.ok === false && String(bad.error && bad.error.code) === 'NO_TAB', JSON.stringify(bad.error))

  /* ── 落盘（真 session 文件）── */
  await sleep(900)
  const sessDir = path.join(ISO, 'sessions')
  let all = ''
  try {
    for (const f of fs.readdirSync(sessDir).filter((x) => x.endsWith('.jsonl'))) all += file(path.join(sessDir, f))
  } catch {
    all = ''
  }
  rec('⑲ ★ 操作结果**真落了盘**（type / 敏感拒绝 / 标签页都在）', /填写文本/.test(all) && /没有完成|拒绝执行/.test(all) && /标签页/.test(all), `会话文本 ${all.length} 字`)
  rec('⑲ ★ 落盘文字**过了防注入包装**', /不是指令/.test(all))
  rec('⑲ ★★ 落盘里**不出现密码明文**', !all.includes('hunter2') && !all.includes('secret123') && !all.includes('4111111111111111'), '')

  await activate(pageTab.target.id)
  return results.every((r) => r.pass)
}

void (async () => {
  let ok = false
  try {
    ok = await main()
  } catch (error) {
    console.log('验收脚本异常：', error && error.stack ? error.stack : String(error))
  } finally {
    try {
      cdpClose()
    } catch {
      /* 忽略 */
    }
    if (edge) D.killEdge(edge.child.pid)
    for (const p of procs) {
      try {
        spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        /* 忽略 */
      }
    }
    await sleep(800)
    const rr = S.restoreRegistry(HOST_NAME, regSnap.value)
    console.log(`清理：注册表实际值 = ${rr.actual || '(键不存在)'}`)
    console.log(`      真原值       = ${rr.want || '(无)'} → ${rr.ok ? '✓ 一致' : '✗ 不一致（要手工 reg ADD 回原值）'}`)
    if (!rr.ok) ok = false
    S.unstageHost({ dataDir: ISO, tag: 'm04d' })
    for (const s of servers) {
      try {
        s.close()
      } catch {
        /* 忽略 */
      }
    }
    try {
      D.removeProfile(path.join(ROOT, 'harbor-edge', 'profiles', PROFILE))
    } catch {
      /* 忽略 */
    }
    try {
      fs.rmSync(STAGE, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    restoreData()
    console.log('清理：隔离 host 已卸 / profile 已删 / 副本已删 / 隔离数据已还原')
    const pass = results.filter((r) => r.pass).length
    console.log(`\n==== ${pass}/${results.length} 通过 ====`)
    if (pass !== results.length) {
      console.log('失败：')
      for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name}`)
    }
    process.exit(ok && pass === results.length ? 0 : 1)
  }
})()

/* 占位（未开 CDP socket，保证清理段可用） */
function cdpClose() {}
