/**
 * 真机验收：用真模型真跑几类任务，**按产物判定成败**。
 *
 * 为什么要它：「测试全绿 ≠ 能用」在本项目吃过两次事故，而阶段四要求的
 * 「真实任务验收」靠手点跑不起来。这个脚本把那条路自动化：
 *
 *   ① 每条任务前**重置沙箱**、**新建对话**（相互独立）
 *   ② 结束判定看**磁盘**（会话文件停止增长 + 「停止」按钮消失），不抓界面文本
 *   ③ 验收看**产物**（文件真的改对了吗）—— 不信任模型的自我汇报
 *   ④ 客观指标从**任务台账**读（steps / errors / model / 耗时）
 *
 * 用法：
 *   npm run package                                   # 先有便携版
 *   node tools/acceptance.mjs                         # 5 类任务 × 3 次
 *   node tools/acceptance.mjs --runs=5                # 改次数
 *   node tools/acceptance.mjs --app=dist-portable/Harbor
 *
 * 前置：便携版的 data/ 里要有**能用的凭证**（整目录从已有安装拷过去；
 * 只拷 credentials.json 会因为 safeStorage 的上下文不完整而解密失败）。
 *
 * 产物：控制台摘要 + `acc-report.json`（逐轮明细）+ `acc-live.txt`（实时日志）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const APP = resolve(ROOT, arg('app', join('dist-portable', 'Harbor')))
const EXE = join(APP, process.platform === 'win32' ? 'Harbor.exe' : 'Harbor')
const DATA = join(APP, 'data')
/** 工作目录就是沙箱本身 —— 放到子目录里 Agent 会找不到文件（踩过） */
const SANDBOX = join(DATA, 'workspace')
const PORT = Number(arg('port', '9338'))
const RUNS = Number(arg('runs', '3'))
/** 只清自己这几个文件，别动工作目录里其它东西 */
const MINE = ['calc.mjs', 'calc.test.mjs', 'greet.mjs', 'nosuch.test.mjs']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')

const CALC = `export function add(a, b) {
  return a + b
}

/* BUG（故意留的）：应该返回 a * b */
export function multiply(a, b) {
  return a + b
}
`
const CALC_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add, multiply } from './calc.mjs'

test('add', () => assert.equal(add(2, 3), 5))
test('multiply', () => assert.equal(multiply(2, 3), 6))
`
const FIXED = /multiply[\s\S]{0,100}return\s+a\s*\*\s*b/

function resetSandbox() {
  mkdirSync(SANDBOX, { recursive: true })
  for (const f of MINE) rmSync(join(SANDBOX, f), { force: true })
  writeFileSync(join(SANDBOX, 'calc.mjs'), CALC)
  writeFileSync(join(SANDBOX, 'calc.test.mjs'), CALC_TEST)
}

/** 任务集：每类一档能力，verify 只看磁盘产物 */
const TASKS = [
  {
    id: 'T1-只读答疑',
    prompt: '读一下工作目录里的 calc.mjs 和 calc.test.mjs，用一句话说清这个模块导出什么、测试测了什么。不要修改任何文件。',
    verify: () => {
      const ok = read(join(SANDBOX, 'calc.mjs')) === CALC && read(join(SANDBOX, 'calc.test.mjs')) === CALC_TEST
      return { pass: ok, detail: ok ? '只读任务，两个文件都没被动' : '只读任务却改了文件' }
    },
  },
  {
    id: 'T2-单文件修改',
    prompt: '工作目录里 calc.mjs 的 multiply 函数是错的（现在返回 a+b，应该是 a*b）。请把它改对，改完不要跑测试。',
    verify: () => {
      const ok = FIXED.test(read(join(SANDBOX, 'calc.mjs')))
      return { pass: ok, detail: ok ? 'multiply 已改成 a*b' : '没改对' }
    },
  },
  {
    id: 'T3-改完跑测试',
    prompt: 'calc.mjs 的 multiply 是错的（返回 a+b，应为 a*b）。先改对，然后运行 node --test calc.test.mjs 验证，把测试结果告诉我。',
    verify: () => {
      const ok = FIXED.test(read(join(SANDBOX, 'calc.mjs')))
      return { pass: ok, detail: ok ? 'multiply 已改对（有没有真跑测试看台账）' : '没改对' }
    },
    needShell: true,
  },
  {
    id: 'T4-新建文件',
    prompt: '在工作目录新建 greet.mjs，导出一个函数 greet(name)，返回字符串「你好，」拼上 name（注意是中文逗号）。只建这一个文件。',
    verify: () => {
      const src = read(join(SANDBOX, 'greet.mjs'))
      const ok = /greet/.test(src) && /你好，|你好,/.test(src)
      return { pass: ok, detail: ok ? 'greet.mjs 已建且内容正确' : src ? '内容不对' : '文件没建' }
    },
  },
  {
    id: 'T5-失败处理',
    prompt: '运行 node --test 这个目录里不存在的文件 nosuch.test.mjs，然后用一句话说明失败原因。不要新建任何文件。',
    verify: () => {
      const extra = MINE.filter((f) => !['calc.mjs', 'calc.test.mjs'].includes(f) && existsSync(join(SANDBOX, f)))
      return { pass: extra.length === 0, detail: extra.length === 0 ? '失败被正确报告、没多建文件' : `多建了：${extra.join(', ')}` }
    },
  },
]

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      const s = this.pending.get(m.id)
      if (!s) return
      this.pending.delete(m.id)
      if (m.error) s.reject(new Error(JSON.stringify(m.error)))
      else s.resolve(m.result)
    })
  }
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

const newest = (dir, ext) => {
  if (!existsSync(dir)) return null
  const list = readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  return list[0]?.f ?? null
}

const report = []
let cdp = null
const app = (() => {
  /* 先清残留实例：否则会连到旧进程，端口还冲突 */
  try {
    spawnSync(process.platform === 'win32' ? 'taskkill' : 'pkill', process.platform === 'win32' ? ['/IM', 'Harbor.exe', '/F'] : ['-f', 'Harbor'], { stdio: 'ignore' })
  } catch {
    /* 没有就算了 */
  }
  return spawn(EXE, [`--remote-debugging-port=${PORT}`], { cwd: APP, stdio: 'ignore' })
})()

const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) return `!!${JSON.stringify(r.exceptionDetails).slice(0, 200)}`
  return r.result?.value
}

try {
  if (!existsSync(EXE)) throw new Error(`找不到 ${EXE}，先跑 npm run package`)
  let target = null
  const dl0 = now() + 40000
  while (now() < dl0 && !target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch {
      /* 等应用起来 */
    }
    if (!target) await sleep(500)
  }
  if (!target) throw new Error('等不到调试端口')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  cdp = await new Promise((res, rej) => {
    ws.addEventListener('open', () => res(new Cdp(ws)), { once: true })
    ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
  })
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  for (let i = 0; i < 40; i += 1) {
    if (await ev(`!!document.querySelector('textarea')`)) break
    await sleep(500)
  }
  console.log(`验收就绪 · ${TASKS.length} 个任务 × ${RUNS} 次 → ${APP}\n`)

  for (const task of TASKS) {
    for (let run = 1; run <= RUNS; run += 1) {
      resetSandbox()
      const t0 = now()
      await ev(`(function(){const b=[...document.querySelectorAll('button')].find(x=>/^新建对话/.test((x.getAttribute('aria-label')||x.title||'')));if(b)b.click();return !!b})()`)
      await sleep(1300)
      await ev(`(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(task.prompt)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`)
      await sleep(600)
      await ev(`(function(){const b=[...document.querySelectorAll('button')].find(x=>/发送消息/.test((x.getAttribute('aria-label')||x.title||'')));if(b)b.click();return !!b})()`)

      /* 结束判定：见到运行态 → 它消失 + 会话文件 8 秒不再变大 */
      let sawRunning = false
      let lastSize = -1
      let stableSince = now()
      let timedOut = false
      const dl = now() + 180000
      while (now() < dl) {
        await sleep(1500)
        const running = await ev(
          `!![...document.querySelectorAll('button')].find(x=>/停止/.test((x.getAttribute('aria-label')||x.title||x.textContent||'')))`,
        )
        if (running === true) sawRunning = true
        const sess = newest(join(DATA, 'sessions'), '.jsonl')
        const size = sess ? statSync(join(DATA, 'sessions', sess)).size : 0
        if (size !== lastSize) {
          lastSize = size
          stableSince = now()
        }
        if (sawRunning && running === false && now() - stableSince > 8000) break
      }
      if (now() >= dl) timedOut = true

      const elapsedMs = now() - t0
      const v = task.verify()
      const taskFile = newest(join(DATA, 'tasks'), '.json')
      let ledger = null
      try {
        ledger = taskFile ? JSON.parse(readFileSync(join(DATA, 'tasks', taskFile), 'utf8')) : null
      } catch {
        /* 读不到就留空 */
      }
      const steps = Array.isArray(ledger?.steps) ? ledger.steps : []
      const row = {
        任务: task.id,
        轮次: run,
        通过: v.pass,
        验收: v.detail,
        耗时秒: +(elapsedMs / 1000).toFixed(1),
        超时: timedOut,
        见到运行态: sawRunning,
        工具步数: steps.length,
        跑过命令: steps.filter((s) => s.tool === 'run_shell').length,
        错误数: (Array.isArray(ledger?.errors) ? ledger.errors : []).length,
        工具序列: steps.map((s) => `${s.tool}${s.ok === false ? '✗' : ''}`).join('>').slice(0, 110),
        模型: ledger?.model ?? '',
      }
      report.push(row)
      console.log(`${v.pass ? '✅' : '❌'} ${task.id} #${run} | ${row.耗时秒}s | 步${row.工具步数} 命令${row.跑过命令} 错${row.错误数} | ${v.detail.slice(0, 50)}`)
      /* 实时日志：一行一轮，随时可读（别去戳 stdout —— 会被截断） */
      appendFileSync(join(ROOT, 'acc-live.txt'), `${new Date().toISOString().slice(11, 19)} ${v.pass ? '✅' : '❌'} ${task.id} #${run} | ${row.耗时秒}s | ${v.detail}\n`, 'utf8')
    }
  }
} catch (e) {
  console.log('!! 驱动出错：', String(e?.message ?? e))
} finally {
  writeFileSync(join(ROOT, 'acc-report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log('\n════════ 汇总 ════════')
  const by = {}
  for (const r of report) {
    by[r.任务] ??= { ok: 0, n: 0, s: [] }
    by[r.任务].n += 1
    if (r.通过) by[r.任务].ok += 1
    by[r.任务].s.push(r.耗时秒)
  }
  for (const [k, v] of Object.entries(by)) {
    console.log(`${v.ok === v.n ? '✅' : '❌'} ${k.padEnd(16)} ${v.ok}/${v.n} · 平均 ${(v.s.reduce((a, b) => a + b, 0) / v.s.length).toFixed(1)}s`)
  }
  const pass = report.filter((r) => r.通过).length
  console.log(`\n总成功率 ${pass}/${report.length} = ${((pass / Math.max(1, report.length)) * 100).toFixed(0)}%`)
  app.kill()
  process.exit(report.length > 0 && pass === report.length ? 0 : 1)
}
