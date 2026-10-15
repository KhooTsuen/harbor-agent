/*
 * 真机端到端：验证「只分析，不修改」误判修好了。
 *
 * 链路全真，只有模型是假的：
 *   真 Electron（源码树）→ 真界面（CDP 填输入框 / 点发送）→ 真 chat handler
 *   → 真 loop.cjs → 真 user-constraints 判据 → 真 tools/index.cjs 那道门
 *   → 真工具执行 → 回来
 *
 * 两个场景（各新建一个对话），假上游按**用户消息内容**决定发什么工具调用：
 *
 *   A) 事故原文（「…不许写成确定的事实…」）—— 那是**输出要求**，不该禁写
 *      第 1 轮 browse（纯读）· 第 2 轮 write_file（会写）
 *      ★ 判据：两个都**没**被「只分析」拦；browse 还真的读到了网页
 *
 *   B) 真约束（「不要修改代码，也不要写文件」）—— 这是真话，必须拦住
 *      第 1 轮 write_file（会写）
 *      ★ 判据：被拦，结果里有「只分析，不修改」
 *
 * ⚠️ 为什么 B 用 write_file 而不是 browse：按 C 的设计，**纯读的 browse
 *    在两种情况下都不该被「只分析」拦**（那句话的本意是「别改我的文件」）。
 *    要验证「判据没松过头」，就得拿一个**真会改动**的工具去撞。
 *
 * 数据隔离：HARBOR_UNIT_TEST=1 → data/unit-test-data，完全不碰仓库真 data。
 * 权限档设为 full（隔离数据里，write_file 不弹确认卡，免得脚本要自己点）。
 * 进程：只按 PID 杀自己起的那个（绝不 taskkill /IM）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, sleep, findPageTarget, evaluate } from './shot/cdp.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ISO = resolve(ROOT, 'data', 'unit-test-data')
const CONF = resolve(ISO, 'config.json')
const CRED = resolve(ISO, 'credentials.json')
const PORT = 9391
const FAKE_PORT = 9983
const PROBE_PORT = 8843
const SHOT = resolve(ROOT, 'tmp', 'constraint-walk', 'electron.png')
const MARKER = 'E2E_PROBE_MARKER_42'

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? '✓' : '✗'} ${name} —— ${detail}`)
}

/* ── 1. 探针（browse 要读的那个页面）── */
const probe = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<html><head><title>PROBE</title></head><body><p>${MARKER}</p></body></html>`)
})
await new Promise((r) => probe.listen(PROBE_PORT, '127.0.0.1', r))

/* ── 2. 假上游 ── */
const captures = { A: '', B: '' }
const sse = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`
const callOf = (name, args) => ({
  index: 0,
  id: `call_${name}_1`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
})

const upstream = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    /*
     * 场景判定用**整个请求体**：不能只看「最后一条 user 消息」——
     * 内核会往消息里 push 合成的 user 消息（顶回话 / 提醒），最后一条未必是用户原话。
     */
    const isA = /不许写成确定的事实/.test(body)
    let toolTexts = []
    try {
      const j = JSON.parse(body)
      const msgs = j.messages ?? []
      toolTexts = msgs
        .filter((m) => m.role === 'tool')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    } catch {
      /* 解析不了就当空 */
    }
    const n = toolTexts.length
    const tag = isA ? 'A' : 'B'

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })

    const finish = () => {
      captures[tag] = toolTexts.join('\n')
      console.log(`  [上游] 采集 ${tag}（${n} 条工具结果）：${toolTexts.join(' | ').slice(0, 150)}`)
      res.write(sse({ content: '好的，看完了。' }))
      res.write('data: [DONE]\n\n')
      res.end()
    }

    if (isA) {
      if (n === 0) {
        res.write(sse({ tool_calls: [callOf('browse', { url: `http://127.0.0.1:${PROBE_PORT}/` })] }))
      } else if (n === 1) {
        res.write(sse({ tool_calls: [callOf('write_file', { path: 'e2e-a.txt', content: 'ok' })] }))
      } else {
        finish()
        return
      }
    } else if (n === 0) {
      res.write(sse({ tool_calls: [callOf('write_file', { path: 'e2e-b.txt', content: 'ok' })] }))
    } else {
      finish()
      return
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
  req.resume()
})
await new Promise((r) => upstream.listen(FAKE_PORT, '127.0.0.1', r))

/* ── 3. 隔离数据 ── */
mkdirSync(ISO, { recursive: true })
const confBackup = existsSync(CONF) ? readFileSync(CONF, 'utf8') : null
const credBackup = existsSync(CRED) ? readFileSync(CRED, 'utf8') : null
const cfg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'config.json'), 'utf8'))
cfg.providers[0].baseUrl = `http://127.0.0.1:${FAKE_PORT}/v1`
/* 完全访问：隔离数据里，write_file 不弹确认卡（否则脚本得自己点卡） */
cfg.tools = { ...(cfg.tools ?? {}), permission: 'full' }
/*
 * 网络策略放行：真数据里的「每次先问」在完全访问档下会**按拒绝处理**
 * （`tools/permission.cjs` 的取舍：没人被问就不发请求）——
 * 那是另一套机制，会把 browse 挡掉，盖住本脚本要测的东西。隔离数据里放开。
 */
cfg.security = {
  ...(cfg.security ?? {}),
  network: { ...(cfg.security?.network ?? {}), mode: 'allow' },
}
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

/* ── 4. 真 Electron（源码树 + 隔离数据根）── */
const app = spawn(BIN, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HARBOR_UNIT_TEST: '1' },
})
const killApp = () => spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })

const NEW_CHAT = `(function(){const re=/^新建对话/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`
const fillExpr = (text) =>
  `(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`
const SEND = `(function(){const re=/发送消息/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`

/* 事故原文（照抄装机版那条会话的尾段） */
const ACCIDENT = `【任务】兼职/零工机会调研

帮我搜一下兼职机会。

三、硬性要求

每一条机会都必须给出可打开的 URL 和来源平台。

凡是你没能在网页上核实的，一律标注「未验证」，不许写成确定的事实。

用 Harbor 内置浏览器看几个页面。`

/* 真约束（对照组） */
const REAL_CONSTRAINT = `帮我看看这个网页。

注意：本轮不要修改代码，也不要写文件，只用浏览器读几页看看就行。`

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
  if (!ready) throw new Error('界面没就绪')

  /* ── 场景 A：事故原文（输出要求，不该禁写）── */
  await ev(NEW_CHAT, '新建对话')
  await sleep(1200)
  await ev(fillExpr(ACCIDENT), '填事故原文')
  await sleep(400)
  await ev(SEND, '点发送')

  let deadline = Date.now() + 120000
  while (Date.now() < deadline && !captures.A) await sleep(600)
  const a = captures.A
  rec(
    '★★ 场景 A：事故原文下 **browse 放行**且真读到网页',
    a.includes(MARKER),
    a.includes(MARKER) ? '读到 E2E_PROBE_MARKER_42' : `没读到：${a.slice(0, 90)}`,
  )
  rec(
    '★★ 场景 A：事故原文下 **write_file 也放行**（这才是「输出要求不该禁写」）',
    a !== '' && !a.includes('只分析'),
    a === '' ? '没采集到' : a.slice(0, 90).replace(/\n/g, ' '),
  )

  /* ── 场景 B：真约束（对照组，必须拦住）── */
  await sleep(1500)
  await ev(NEW_CHAT, '新建对话')
  await sleep(1200)
  await ev(fillExpr(REAL_CONSTRAINT), '填真约束')
  await sleep(400)
  await ev(SEND, '点发送')

  deadline = Date.now() + 120000
  while (Date.now() < deadline && !captures.B) await sleep(600)
  const b = captures.B
  rec(
    '★★ 场景 B：真约束下 write_file **仍被拦**（判据没松过头）',
    b.includes('只分析'),
    b === '' ? '没采集到' : b.slice(0, 90).replace(/\n/g, ' '),
  )

  await sleep(2500)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(resolve(ROOT, 'tmp', 'constraint-walk'), { recursive: true })
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
  probe.close()
  upstream.close()
}

const passed = results.filter((r) => r.pass).length
console.log(`\n${passed === results.length ? '✅ 全过' : '❌ 有失败'}（${passed}/${results.length}）`)
process.exit(passed === results.length ? 0 : 1)
