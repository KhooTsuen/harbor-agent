/**
 * 真机验收：**审批档位**（设置 → 经验与规则）—— 人能不能把一条候选变成规则
 *
 * 为什么要有：界面 `ExperienceTab.tsx` 只跑过 tsc 和构建，而「按钮点了有没有反应」这类事
 * tsc / lint / 单测一律看不出来（项目里为此栽过两次）。所以这里**点真按钮**，再去磁盘读
 * experiences.json 核对：DOM 那句「已批准」是界面自己画的，磁盘上的 status 才是内核的意思。
 *
 * 真机才看得见的两件事：① 设置**默认是简洁视图**，「经验与规则」不在导航里，得先切详细视图；
 * ② 那一页默认筛「待处理」，已生效 / 已驳回的不切「全部」就找不到。
 *
 * 用法：node tools/e2e-experience-approve.mjs（起 node_modules 里的源码树 Electron，不必打包）
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, sleep, findPageTarget, evaluate } from './shot/cdp.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ISO = resolve(ROOT, 'data', 'unit-test-data')
const CONF = resolve(ISO, 'config.json')
const CRED = resolve(ISO, 'credentials.json')
const EXP = resolve(ISO, 'experiences.json')
const PORT = 9385
const SHOT = resolve(ROOT, 'shots', 'electron', 'experience-approve.png')

/* 三条的触发文本 —— 界面按它定位行（写死 id 会随重铺数据失效，踩过） */
const TEXT = { A: 'npm test 失败', B: '文件不存在', C: '编辑失败', D: '权限被拒' }
/* 人批准时手写的那句（必须是这句话，最后要一字不差地读回来） */
const HOW = '先确认路径存在再读'
/* 批准之后「改做法」写成的那句（同上：一字不差读回来） */
const NEWHOW = '先跑 dir 确认路径，再读文件'

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? '✓' : '✗'} ${name} —— ${detail}`)
}

/* ── ① 铺数据：走内核真入口（store.addCandidate），不手写 JSON ── */
process.env.HARBOR_UNIT_TEST = '1'
const schema = (await import(`file://${resolve(ROOT, 'electron/core/experience-schema.cjs')}`)).default
const store = (await import(`file://${resolve(ROOT, 'electron/core/experience-store.cjs')}`)).default
const file = (await import(`file://${resolve(ROOT, 'electron/core/experience-store-file.cjs')}`)).default

mkdirSync(ISO, { recursive: true })
file.persist({ version: 1, items: [] })
const seed = (tool, text, args) => {
  const added = store.addCandidate({
    feature: schema.featureOf({ tool, text, category: 'tool_failure', args }),
    causeHypothesis: '系统侧分类器提示',
    risk: 'low',
    scope: 'global',
    projectId: '',
    sessionId: 'sess_e2e_approve',
  })
  if (!added.ok) throw new Error(`铺数据失败：${added.dropped}`)
  return added.item
}
seed('run_shell', `${TEXT.A}：断言不成立`, { command: 'npm test --filter a' })
seed('read_file', `${TEXT.B}：ENOENT`, { path: 'E:/tmp/缺少.txt' })
const c = seed('edit_file', `${TEXT.C}：匹配不到那段文本`, { path: 'E:/tmp/目标.md' })
const d = seed('run_shell', `${TEXT.D}：DENIED`, { command: 'npm run deploy' })
/* C 抬成 verified：界面要出现「驳回」。走 file.recordMove（唯一往 history 写迁移的地方） */
{
  const data = file.load()
  const target = data.items.find((item) => item.id === c.id)
  file.recordMove(target, schema.STATUS.CANDIDATE, schema.STATUS.VERIFIED, '铺数据：模拟已生效')
  target.recommendedAction = '先读一遍再改'
  target.approval = { by: 'user', at: Date.now(), action: 'approve', note: '', actionText: '先读一遍再改' }

  /* D 抬成 suspended（被反例打停）：界面要出现「恢复」。★ 必须带着一条 contradiction 进来 ——
     恢复的要点是「状态回来、反例记录不清零」，铺数据时没有反例，这一趟就验不出东西 */
  const suspended = data.items.find((item) => item.id === d.id)
  file.recordMove(suspended, schema.STATUS.CANDIDATE, schema.STATUS.VERIFIED, '铺数据：模拟生效过')
  suspended.recommendedAction = '部署前先跑一遍只读检查'
  suspended.contradictions = [
    { at: Date.now(), opportunityId: 'seed', evidence: '又一次 DENIED', projectId: '', sessionId: 'sess_e2e_approve' },
  ]
  file.recordMove(suspended, schema.STATUS.VERIFIED, schema.STATUS.SUSPENDED, '铺数据：同类反例打停')
  file.persist(data)
}

/* ── ② 隔离配置（只是为了让应用能起来；这一条验收不发消息、不联网） ── */
const confBackup = existsSync(CONF) ? readFileSync(CONF, 'utf8') : null
const credBackup = existsSync(CRED) ? readFileSync(CRED, 'utf8') : null
const cfg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'config.json'), 'utf8'))
writeFileSync(CONF, JSON.stringify(cfg, null, 2))
writeFileSync(
  CRED,
  JSON.stringify(
    { version: 1, backend: 'plain', entries: { [cfg.providers[0].credentialRef]: { value: 'sk-e2e', updatedAt: Date.now() } } },
    null,
    2,
  ),
)
const restoreData = () => {
  try {
    if (confBackup === null) rmSync(CONF, { force: true })
    else writeFileSync(CONF, confBackup)
    if (credBackup === null) rmSync(CRED, { force: true })
    else writeFileSync(CRED, credBackup)
  } catch {
    /* ignore */
  }
}

/** 读**磁盘**上的那条（按工具名找，三条工具各不同） */
const onDisk = (tool) => {
  try {
    const items = JSON.parse(readFileSync(EXP, 'utf8')).items ?? []
    return items.find((item) => item.tool === tool) ?? null
  } catch {
    return null
  }
}

/* ── ③ 界面脚本：打开设置 → 详细视图 → 经验与规则 → 全部 → 三个动作 ── */
const UI = `(function(){
  var T=${JSON.stringify(TEXT)}, HOW=${JSON.stringify(HOW)}, NEWHOW=${JSON.stringify(NEWHOW)}, log=[]
  function say(s,v){log.push(s+' → '+(typeof v==='string'?v:JSON.stringify(v)))}
  function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
  function rows(){return [].slice.call(document.querySelectorAll('[data-experience-id]'))}
  function rowOf(k){return rows().filter(function(el){return (el.innerText||'').indexOf(T[k])>=0})[0]||null}
  function st(k){var el=rowOf(k);return el?el.getAttribute('data-experience-status'):'missing'}
  function btn(el,label){return el&&[].slice.call(el.querySelectorAll('button')).filter(function(b){return (b.getAttribute('aria-label')||'')===label})[0]||null}
  function byText(t){var h=[].slice.call(document.querySelectorAll('button')).filter(function(b){return (b.textContent||'').trim()===t})[0];if(h)h.click();return !!h}
  function navOf(){return [].slice.call(document.querySelectorAll('nav button')).filter(function(b){return (b.textContent||'').trim()==='经验与规则'})[0]}
  return (async function(){
    var gear=[].slice.call(document.querySelectorAll('button')).filter(function(b){return /设置/.test(b.getAttribute('aria-label')||'')})[0]
    if(!gear) return ['失败：找不到设置按钮'].concat(log).join('\\n')
    gear.click(); await sleep(1800)
    /* 归零到简洁视图：上次跑点「去处理」会把 settingsView=detailed 持久化到 localStorage，
       第二趟打开就没有点名行了（那行只在经验页被收起时出现）—— 不归零就只能过第一趟 */
    byText('对话'); await sleep(900)
    var viewSel=document.querySelector('select[aria-label="设置页视图"]')
    if(viewSel&&viewSel.value!=='simple'){
      var sset=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set
      sset.call(viewSel,'simple'); viewSel.dispatchEvent(new Event('change',{bubbles:true})); await sleep(1400)
    }
    say('⓪前 视图归到简洁（可重复跑的前提）', viewSel?viewSel.value:'（没找到视图下拉）')
    /* ⓪ 简洁视图有没有点名「有 N 条等你处理」（遗留 8）：审批入口默认收着，不点名就没人知道 */
    var notice=[].slice.call(document.querySelectorAll('p')).filter(function(p){return /在等你处理/.test(p.innerText||'')})[0]
    /* 标签里**不能**再出现「在等你处理」——判据是按日志行匹配的，标签带原文会让「没找到」也判绿 */
    say('⓪ 点名行', notice?notice.innerText.replace(/\\s+/g,' ').slice(0,60):'（没找到）')
    var goBtn=notice&&[].slice.call(notice.querySelectorAll('button')).filter(function(b){return (b.getAttribute('aria-label')||'')==='去处理待审批的经验'})[0]
    if(!goBtn) return ['失败：点名那一行里没有「去处理」按钮'].concat(log).join('\\n')
    goBtn.click(); await sleep(1800)
    say('⓪ 点「去处理」之后落到经验页', !!navOf())
    var nav=navOf()
    if(!nav){
      var d=[].slice.call(document.querySelectorAll('button')).filter(function(b){return /切到详细视图/.test((b.textContent||'').trim())})[0]
      if(!d) return ['失败：简洁视图里没有入口，也没有「切到详细视图」'].concat(log).join('\\n')
      d.click(); await sleep(1300); nav=navOf()
      say('① 退回老路：点详细视图后有了入口', !!nav)
    }
    if(!nav) return ['失败：切到详细视图后仍没有「经验与规则」'].concat(log).join('\\n')
    nav.click(); await sleep(1600)
    say('② 点「全部」', byText('全部')); await sleep(900)
    say('② 三条状态', [st('A'),st('B'),st('C')])
    var ab=btn(rowOf('B'),'批准这条经验')
    if(!ab) return ['失败：B 那行没有「批准」按钮'].concat(log).join('\\n')
    ab.click(); await sleep(1400)
    say('③ 空壳批准后状态', st('B'))
    say('③ 出现「没批成」', /没批成/.test(document.body.innerText))
    var r=rowOf('B'), input=r?r.querySelector('input[aria-label="批准时使用的做法"]'):null
    if(!input) return ['失败：B 那行没有做法输入框'].concat(log).join('\\n')
    var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
    set.call(input,HOW); input.dispatchEvent(new Event('input',{bubbles:true})); await sleep(500)
    var ok=btn(rowOf('B'),'批准这条经验')
    if(!ok) return ['失败：填完做法后「批准」按钮不见了'].concat(log).join('\\n')
    ok.click(); await sleep(1600)
    say('④ 填做法后状态', st('B'))
    var rb=rowOf('B'); say('④ 行里出现那句做法', rb?rb.innerText.indexOf(HOW)>=0:'missing')
    var rc=btn(rowOf('C'),'驳回这条经验')
    if(!rc) return ['失败：C 那行没有「驳回」按钮'].concat(log).join('\\n')
    rc.click(); await sleep(1600)
    say('⑤ 驳回后状态', st('C'))
    var rcc=rowOf('C'); say('⑤ 驳回后不再说「会进提示」', rcc?!/会进提示/.test(rcc.innerText):'missing')
    var ress=btn(rowOf('D'),'恢复这条经验')
    if(!ress) return ['失败：D 那行没有「恢复」按钮'].concat(log).join('\\n')
    ress.click(); await sleep(1600)
    say('⑥ 恢复后状态', st('D'))
    /* ⑦ 改做法（amend）：只换那句话、状态不动 —— 挑刚批准过的 B，「改完仍是 verified」才是要点 */
    var eb=btn(rowOf('B'),'修改这条经验的做法')
    if(!eb) return ['失败：B 那行没有「改做法」按钮'].concat(log).join('\\n')
    eb.click(); await sleep(900)
    var r2=rowOf('B'), inp2=r2?r2.querySelector('input[aria-label="批准时使用的做法"]'):null
    if(!inp2) return ['失败：点了「改做法」但没有输入框'].concat(log).join('\\n')
    say('⑦ 点开「改做法」时输入框里是原句', inp2.value===HOW)
    set.call(inp2,NEWHOW); inp2.dispatchEvent(new Event('input',{bubbles:true})); await sleep(500)
    var sb=btn(rowOf('B'),'保存修改后的做法')
    if(!sb) return ['失败：没有「保存」按钮'].concat(log).join('\\n')
    sb.click(); await sleep(1600)
    say('⑦ 改做法后状态', st('B'))
    var r3=rowOf('B'); say('⑦ 行里出现新那句', r3?r3.innerText.indexOf(NEWHOW)>=0:'missing')
    return log.join('\\n')
  })()
})()`

/* ── ④ 起应用、跑界面、读盘核对 ── */
const app = spawn(BIN, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HARBOR_UNIT_TEST: '1' },
})
const killApp = () => spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })

let cdp
try {
  await sleep(1500)
  const target = await findPageTarget(PORT, { timeoutMs: 45000 })
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await sleep(2200)

  const out = await evaluate(cdp, UI, { label: '审批档位界面' })
  for (const line of String(out ?? '（界面脚本没有返回值）').split('\n')) console.log(`  ${line}`)
  rec('界面脚本跑到底（没有中途 fail）', !String(out).startsWith('失败'), String(out).split('\n').slice(-1)[0])
  rec(
    '★★ 简洁视图里点名了「有 N 条在等你处理」（不再默认看不见审批入口）',
    /⓪ 点名行 → [^（]/.test(String(out)),
    String(out).split('\n').find((line) => line.includes('⓪ 点名行')) ?? '（没有这一行）',
  )
  rec(
    '★★ 点「去处理」真的落到了经验页（一键直达，不是只给一句话）',
    /⓪ 点「去处理」之后落到经验页 → true/.test(String(out)),
    String(out).split('\n').find((line) => line.includes('去处理')) ?? '（没有这一行）',
  )

  /* 判据看**磁盘**：DOM 那句「生效中」是界面自己画的，只有 experiences.json 说得准 */
  const b = onDisk('read_file')
  const cc = onDisk('edit_file')
  rec('★ B 批准后真的 verified（磁盘）', b?.status === 'verified', `status=${b?.status}`)
  rec(
    '★★ 改做法之后，注入用的是**新那句**（一字不差）',
    b?.recommendedAction === NEWHOW,
    String(b?.recommendedAction),
  )
  rec('★★ 改做法**没碰状态**（批准过、改完仍是 verified）', b?.status === 'verified', `status=${b?.status}`)
  rec(
    '★★ 批准那一刻的做法仍在历史里（approval.actionText 不被覆盖）',
    b?.approval?.actionText === HOW,
    String(b?.approval?.actionText),
  )
  rec(
    '★ 改做法留了痕（history 里有一条「改」）',
    (b?.history ?? []).some((h) => /改/.test(h.why ?? '')),
    JSON.stringify((b?.history ?? []).map((h) => h.why)),
  )
  rec('★ 批准记着是人批的', b?.approval?.by === 'user', JSON.stringify(b?.approval?.action ?? null))
  rec('★ B 现在可注入（内核判据一处）', schema.injectable(b) === true, `injectable=${schema.injectable(b)}`)
  rec('★ C 驳回后真的 rejected（磁盘）', cc?.status === 'rejected', `status=${cc?.status}`)
  rec('★ C 不再可注入', schema.injectable(cc) === false, `injectable=${schema.injectable(cc)}`)
  rec(
    '★ 批准与驳回都留了痕（history）',
    (b?.history ?? []).some((h) => h.to === 'verified') &&
      (cc?.history ?? []).some((h) => h.to === 'rejected'),
    JSON.stringify((cc?.history ?? []).map((h) => `${h.from}→${h.to}`)),
  )

  /* ── 恢复（suspended → verified）：最容易出事的一条 ── */
  const dd = onDisk('run_shell') && JSON.parse(readFileSync(EXP, 'utf8')).items.find((i) => i.tool === 'run_shell' && i.triggerText.includes(TEXT.D))
  rec('★ D 恢复后真的 verified（磁盘）', dd?.status === 'verified', `status=${dd?.status}`)
  rec('★★ 恢复**没有清掉**反例记录（恢复的是状态，不是历史）', (dd?.contradictions ?? []).length === 1, `contradictions=${(dd?.contradictions ?? []).length}`)
  rec('★ 恢复记着是被反例打过的那条（approval.action=restore）', dd?.approval?.action === 'restore', String(dd?.approval?.action))
  rec('★ 恢复后它又能注入了', schema.injectable(dd) === true, `injectable=${schema.injectable(dd)}`)

  /* 截图：跳过开机动画（真实鼠标事件，和 tool-failure-visible 一样） */
  const bootOn = `(function(){return [...document.querySelectorAll('div')].some(n=>(n.textContent||'').includes('CLICK TO SKIP') && n.clientHeight>0)})()`
  if (await evaluate(cdp, bootOn, { label: '启动层' })) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: 400, y: 300, button: 'left', clickCount: 1 })
    }
    await sleep(1500)
  }
  await sleep(600)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(resolve(ROOT, 'shots', 'electron'), { recursive: true })
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
  console.log(`  截图 → ${SHOT}`)
} catch (error) {
  console.error('E2E 失败：', error instanceof Error ? error.message : error)
  rec('E2E 跑通', false, String(error?.message ?? error))
} finally {
  try {
    cdp?.ws.close()
  } catch {
    /* ignore */
  }
  killApp()
  restoreData()
}

const passed = results.filter((r) => r.pass).length
console.log(`\n${passed === results.length ? '✅ 全过' : '❌ 有失败'}（${passed}/${results.length}）`)
process.exit(passed === results.length ? 0 : 1)
