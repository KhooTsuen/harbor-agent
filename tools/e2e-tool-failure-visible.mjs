/*
 * 真机端到端：**工具真失败时界面上那一行是不是「失败」**（不是绿勾）。
 *
 * 为什么要有它：2026-11-02 之前「这次调用成不成功」全靠文本前缀判
 * （`text.startsWith('错误：')`），而 `run_shell` 跑一条退出码非 0 的命令时正文里
 * 只有 `[退出码 7]`、没有 `错误：` 前缀 —— 于是失败被画成绿勾。这条链路
 * `tsc` / 自检 / 单测全绿也照样错（它们都没真跑过一条会失败的命令再读界面）。
 *
 * 链路全真，只有模型是假的：
 *   真 Electron（源码树）→ 真界面 → CDP 点发送 → 真 chat handler → 真 loop.cjs
 *   → 真 tool-runner → 真 run_shell（cmd `exit /b 7`）→ 真事件 → 真渲染
 *
 * 判据：界面上那条工具行的 `data-run-status` = failed、文案是「失败」、退出码看得见。
 *      判据读的是**真实 DOM**，不是事件流里自己拼的对象。
 *
 * 数据隔离：HARBOR_UNIT_TEST=1 → data/unit-test-data，不碰仓库真 data。
 *
 *   node tools/e2e-tool-failure-visible.mjs
 *   截图 → shots/electron/tool-failure-visible.png
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, sleep, findPageTarget, evaluate } from './shot/cdp.mjs'
import { NEW_CHAT, SEND } from './shot/ui-selectors.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ISO = resolve(ROOT, 'data', 'unit-test-data')
const CONF = resolve(ISO, 'config.json')
const CRED = resolve(ISO, 'credentials.json')
const PORT = 9381
const FAKE_PORT = 9981
const SHOT = resolve(ROOT, 'shots', 'electron', 'tool-failure-visible.png')

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? '✓' : '✗'} ${name} —— ${detail}`)
}

mkdirSync(ISO, { recursive: true })
const confBackup = existsSync(CONF) ? readFileSync(CONF, 'utf8') : null
const credBackup = existsSync(CRED) ? readFileSync(CRED, 'utf8') : null
const cfg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'config.json'), 'utf8'))
cfg.providers[0].baseUrl = `http://127.0.0.1:${FAKE_PORT}/v1-shellfail`
/*
 * 权限档位必须是 full：这条 e2e 要验的是「失败那一行画成什么样」，
 * 不是「权限确认卡拦没拦住」。留在默认的 ask 档时 `run_shell` 会先弹确认卡，
 * 脚本没点它 → 命令根本没跑 → 读回的是上一段历史会话的 DOM，
 * 于是**判据全绿但什么都没验**（2026-11-02 真机踩到：截图上是历史会话 + 「暂不能发送」）。
 */
cfg.security = { ...(cfg.security ?? {}), network: { ...(cfg.security?.network ?? {}), mode: 'allow' } }
cfg.tools = { ...(cfg.tools ?? {}), permission: 'full' }
writeFileSync(CONF, JSON.stringify(cfg, null, 2))
writeFileSync(
  CRED,
  JSON.stringify(
    {
      version: 1,
      backend: 'plain',
      entries: { [cfg.providers[0].credentialRef]: { value: 'sk-e2e', updatedAt: Date.now() } },
    },
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

const upstream = spawn(process.execPath, [resolve(ROOT, 'tools', 'fake-upstream.mjs')], {
  cwd: ROOT,
  env: { ...process.env, FAKE_PORT: String(FAKE_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
upstream.stdout.on('data', (b) => process.stdout.write(`  [上游] ${b}`))
upstream.stderr.on('data', (b) => process.stderr.write(`  [上游err] ${b}`))

const app = spawn(BIN, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HARBOR_UNIT_TEST: '1' },
})
const killApp = () => spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })

const fillExpr = (text) =>
  `(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`
/* 读回工具行：状态 + 文案 + 那一行里能看到的文本 */
const READ_RUNS = `(function(){
  const rows=[...document.querySelectorAll('[data-run-status]')]
  return rows.map(r=>({ status:r.getAttribute('data-run-status'), text:(r.textContent||'').trim().slice(0,200) }))
})()`
/* 整段对话正文（要看得到退出码 / 失败说明） */
const READ_BODY = `(function(){const m=document.querySelector('main')||document.body;return (m.textContent||'').replace(/\\s+/g,' ').slice(-3000)})()`

let cdp
try {
  await sleep(1500)
  const target = await findPageTarget(PORT, { timeoutMs: 45000 })
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const ev = (expr, label) => evaluate(cdp, expr, { label })

  const ready = await (async () => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (await ev(`!!document.querySelector('textarea')`, '等输入框')) return true
      await sleep(500)
    }
    return false
  })()
  rec('界面就绪（有输入框）', ready, ready ? 'textarea 出现' : '30 秒没等到')
  if (!ready) throw new Error('界面没起来')

  await ev(NEW_CHAT, '新建对话')
  await sleep(1200)
  await ev(fillExpr('跑一条会失败的命令看看'), '填输入框')
  await sleep(300)
  rec('发送按钮可点', (await ev(SEND, '点发送')) === true, '已点发送')

  /* 等那条工具行出现并定型（最多 60 秒） */
  let rows = []
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    rows = await ev(READ_RUNS, '读工具行')
    if (Array.isArray(rows) && rows.some((r) => r.status === 'failed')) break
    await sleep(800)
  }
  const shellRow = (rows || []).find((r) => /run_shell|执行命令|退出码/.test(r.text)) || rows?.[0]
  rec(
    '★ 界面上那一行是 failed（改动前这里是 completed 绿勾）',
    shellRow?.status === 'failed',
    shellRow ? `status=${shellRow.status} · ${shellRow.text.slice(0, 80)}` : '没有工具行',
  )

  const body = await ev(READ_BODY, '读正文')
  rec(
    '界面上写的是「失败」（不是「成功」）',
    typeof body === 'string' && body.includes('失败') && !/成功\s*$/.test(body.slice(-6)),
    String(body ?? '').slice(-160),
  )
  rec(
    '退出码在界面上看得到（7）',
    typeof body === 'string' && /7/.test(body) &&
      (typeof body === 'string' && (body.includes('退出码') || body.includes('EXIT_CODE'))),
    String(body ?? '').match(/退出码[^\s]*|EXIT_CODE/g)?.slice(0, 4).join(' / ') ?? '没看到',
  )

  /*
   * 截图前先把启动动画让开（`BootSequence`：播放中点击任意处跳过，总时长 10 秒）。
   * ★ 用 CDP 派发**真实鼠标事件**（不是 `body.dispatchEvent` —— 那个事件只往上冒，
   *   永远到不了覆盖层自己的 onMouseDown，试过一次，没生效）。
   * ★ 这只是为了「让人看得见结果」：上面那几条判据读的是真实 DOM，早就取到了。
   */
  const bootOn = `(function(){return [...document.querySelectorAll('div')].some(n=>(n.textContent||'').includes('CLICK TO SKIP') && n.clientHeight>0)})()`
  if (await ev(bootOn, '启动层在不在')) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: 400,
        y: 300,
        button: 'left',
        clickCount: 1,
      })
    }
  }
  const gone = await (async () => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (!(await ev(bootOn, '等启动层消失'))) return true
      await sleep(500)
    }
    return false
  })()
  rec('启动动画跳过（截图才拍得到界面，而不是一屏开机动画）', gone, gone ? '启动层已消失' : '15 秒仍在')
  await sleep(1200)
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
  spawn('taskkill', ['/pid', String(upstream.pid), '/T', '/F'], { stdio: 'ignore' })
  restoreData()
}

const passed = results.filter((r) => r.pass).length
console.log(`\n${passed === results.length ? '✅ 全过' : '❌ 有失败'}（${passed}/${results.length}）`)
process.exit(passed === results.length ? 0 : 1)
