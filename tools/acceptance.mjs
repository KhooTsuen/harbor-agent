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
 * 前置：便携版的 data/ 里要有**能用的凭证** —— **整目录**从已有安装拷过去（`E:\Harbor\data\*`）。
 *   为什么必须整目录：`safeStorage` 的密钥在**数据目录**里（`data/chromium/Local State` 的
 *   `os_crypt.encrypted_key`），密文只在写入它时那套 `chromium/` 下能解开 ——
 *   只拷 `credentials.json` **必然** `decryptString` 失败（实测两边密钥指纹不同；2026-10-02 又踩一次）。
 *   也别误判成「绑 exe 路径」：换路径没事，用的是哪套 `data/chromium` 才是关键。
 *   ⚠️ 凭证不可用时验收会**假绿**：模型一次都没答上来，而 T1 这类只读任务的判据是
 *   「文件没被动」→ 照样 ✅，每轮还白耗满 180 秒。**跑之前先确认**便携版日志里
 *   「凭证解密失败」是 0 条（或 `logs/token-metrics.jsonl` 有新增行）。
 *   ⚠️ 跑完清理：删掉拷进去的 `credentials.json` 并把 config 恢复默认（别把真实凭证留在发布物里）。
 *   这套（备份 → 整目录拷 → 断言密钥指纹 → 跑 → 还原）已脚本化：`tmp/b4-acc-run.cjs` +
 *   `tmp/b4-acc-restore.cjs`。
 *
 * 产物：控制台摘要 + `acc-report.json`（逐轮明细）+ `acc-live.txt`（实时日志）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { buildCases } from './acceptance-cases.mjs'
import { prepareSandbox } from './acceptance-sandbox.mjs'
import { normalize, observeRound } from './acceptance-verdict.mjs'
import { preflightBad, summarize } from './acceptance-report.mjs'
import { Cdp } from './acceptance-cdp.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const APP = resolve(ROOT, arg('app', join('dist-portable', 'Harbor')))
const EXE = join(APP, process.platform === 'win32' ? 'Harbor.exe' : 'Harbor')
const DATA = join(APP, 'data')
/** 工作目录就是沙箱本身 —— 放到子目录里 Agent 会找不到文件（踩过） */
const SANDBOX = join(DATA, 'workspace')
const PORT = Number(arg('port', '9338'))
const RUNS = Number(arg('runs', '3'))
const ONLY = arg('only', '')
const INSPECT = process.argv.includes('--inspect')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()

const newest = (dir, ext) => {
  if (!existsSync(dir)) return null
  const list = readdirSync(dir)
    .filter((f) => f.endsWith(ext) && !f.startsWith('_'))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  return list[0]?.f ?? null
}

/** 当天应用日志（人看的那个）—— 「这一轮到底有没有请求过模型」从这儿看 */
const logText = () => {
  const d = new Date()
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const p = join(DATA, 'logs', `${key}.log`)
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  } catch {
    return ''
  }
}

/*
 * 前置检查、汇总与退出码在 `acceptance-report.mjs`；这里只留驱动本身
 * （起应用 / 发消息 / 等结束 / 每轮观测）。
 */

/* 任务集与沙箱在 acceptance-cases.mjs；这边只管驱动（起应用、发消息、等结束、统计） */
const TASKS = buildCases({
  sandbox: SANDBOX,
  newestSession: () => {
    const file = newest(join(DATA, 'sessions'), '.jsonl')
    return file ? join(DATA, 'sessions', file) : ''
  },
})

const report = []
{
  const bad = preflightBad({ data: DATA, sandbox: SANDBOX })
  if (bad.length) {
    console.log('⛔ 前置不成立，拒绝开始（否则多半白跑，或者拿假绿换一个 ✅）：')
    for (const b of bad) console.log(`   · ${b}`)
    console.log('   补法：最小集拷贝 credentials.json + config.json + chromium/Local State（见 tmp/b4-acc-run.cjs）')
    process.exit(2)
  }
  console.log('前置检查✓ config.workdir 指向沙箱 · 凭证 backend=safeStorage · chromium/Local State 在')
}
let cdp = null
const app = (() => {
  /* 先清残留实例：否则会连到旧进程，端口还冲突 */
  try {
    spawnSync(process.platform === 'win32' ? 'taskkill' : 'pkill', process.platform === 'win32' ? ['/IM', 'Harbor.exe', '/F'] : ['-f', 'Harbor'], { stdio: 'ignore' })
  } catch {
    /* 没有就算了 */
  }
  return spawn(
    EXE,
    [`--remote-debugging-port=${PORT}`, ...(INSPECT ? ['--inspect=9229'] : [])],
    { cwd: APP, stdio: 'ignore' },
  )
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
    if (ONLY && !task.id.includes(ONLY)) continue
    for (let run = 1; run <= RUNS; run += 1) {
      /*
       * 上一轮如果还没收尾（超时了），先把「停止」按掉再开下一轮 ——
       * 否则此刻的「发送消息」键是「停止」，驱动点不到它，两边互等（2026-10-02 就这么僵住的）。
       */
      for (let i = 0; i < 20; i += 1) {
        const stopped = await ev(
          `(function(){const re=/停止/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`,
        )
        if (stopped !== true) break
        await sleep(1500)
      }
      prepareSandbox(SANDBOX)
      const logBefore = logText().length
      const t0 = now()
      /*
       * 点「新建对话」：**三处任一命中**（aria-label / title / 文本）。
       * 以前只看 aria-label，而侧栏那个按钮没有它 → 一直静静点不到，
       * 于是每轮都落在**上一条会话**里（历史越攼越长、工作目录也不是沙箱）。
       */
      const created = await ev(
        `(function(){const re=/^新建对话/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`,
      )
      if (created !== true) console.log('  ⚠️ 没点到「新建对话」—— 本轮可能落在旧会话里')
      await sleep(1300)
      await ev(`(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(task.prompt)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`)
      await sleep(600)
      const sent = await ev(
        `(function(){const re=/发送消息/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`,
      )
      if (sent !== true) console.log('  ⚠️ 没点到「发送消息」（可能被原生对话框挡住 / 上一轮没收尾）')

      /* 结束判定：见到运行态 → 它消失 + 会话文件 8 秒不再变大 */
      let sawRunning = false
      let lastSize = -1
      let stableSince = now()
      let timedOut = false
      /* AG-053：这次有没有弹过澄清卡（含糊需求要看的那个数） */
      let clarifyCount = 0
      const cardTexts = []
      const dl = now() + (task.vague === true ? 300000 : 180000)
      while (now() < dl) {
        await sleep(1500)
        /*
         * 澄清卡：自动化里「用户」就是这个脚本。
         * 不答的话这一轮会一直等到离场超时（10 分钟），把 180 秒的预算拖爆 ——
         * 所以看见就点「跳过」（那条路 = 让模型自己拿主意），并把次数记下来。
         */
        const card = await ev(
          `(function(){const c=document.querySelector('section[aria-label="开工前先对齐"]');return c?String(c.textContent||'').replace(/\\s+/g,' ').slice(0,900):false})()`,
        )
        if (card) {
          clarifyCount += 1
          if (!cardTexts.length) cardTexts.push(card)
          await ev(
            `(function(){const c=document.querySelector('section[aria-label="开工前先对齐"]');if(!c)return false;` +
              `const b=[...c.querySelectorAll('button')].find(x=>/跳过/.test(x.textContent||''));if(b){b.click();return true}return false})()`,
          )
          await sleep(900)
        }
        const running = await ev(
          `(function(){const re=/停止/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());return !!([...document.querySelectorAll('button')].find(hit))})()`,
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
      const taskFile = newest(join(DATA, 'tasks'), '.json')
      let ledger = null
      try {
        ledger = taskFile ? JSON.parse(readFileSync(join(DATA, 'tasks', taskFile), 'utf8')) : null
      } catch {
        /* 读不到就留空 */
      }
      const steps = Array.isArray(ledger?.steps) ? ledger.steps : []
      const askedInLedger = steps.some((s) => s.tool === 'ask_user')
      /*
       * 含糊用例的判据可能要看卡片原文（T10「有没有说清代价」）与台账里有没有 ask_user；
       * A2 起还要把 **台账步骤** 一起给过去 —— T12 要看「有没有没问就扫全盘」，
       * 而它只能从步骤里看（卡片文本看不见已经跑掉的命令）。
       * 老判据（T9–T11）忽略多出来的这个键，行为不变。
       */
      const v = normalize(
        task.verify({ clarifyText: cardTexts.join(' | '), clarifyCount, askedInLedger, steps }),
      )
      /*
       * ★ 观测护欏（方案第 ② 条）：这一轮到底有没有真的跑到模型？
       * 观测不到就判 `unknown` —— 既不算过也不算不过，不拿它充 ✓。
       */
      const guard = observeRound({ timedOut, logSlice: logText().slice(logBefore), steps })
      const outcome = guard ? guard.outcome : v.outcome
      const detail = guard ? `${guard.detail}（判据本会判 ${v.outcome}：${v.detail}）` : v.detail
      const evidence = guard ? `${guard.evidence} · 判据证据：${v.evidence}` : v.evidence
      const mark = outcome === 'pass' ? '✅' : outcome === 'fail' ? '❌' : '⚠️'
      const row = {
        任务: task.id,
        轮次: run,
        结局: outcome,
        通过: outcome === 'pass',
        验收: detail,
        证据: evidence,
        观测护栏: guard?.evidence ?? '',
        耗时秒: +(elapsedMs / 1000).toFixed(1),
        超时: timedOut,
        见到运行态: sawRunning,
        工具步数: steps.length,
        跑过命令: steps.filter((s) => s.tool === 'run_shell').length,
        错误数: (Array.isArray(ledger?.errors) ? ledger.errors : []).length,
        工具序列: steps.map((s) => `${s.tool}${s.ok === false ? '✗' : ''}`).join('>').slice(0, 110),
        模型: ledger?.model ?? '',
        /* AG-053：含糊需求要看的那个数（≥ 2/3 才算过，见 acceptance-cases.mjs） */
        澄清卡: clarifyCount,
        含糊需求: task.vague === true,
      }
      report.push(row)
      console.log(
        `${mark} ${task.id} #${run} | ${row.耗时秒}s | 步${row.工具步数} 命令${row.跑过命令} 错${row.错误数} | ${detail.slice(0, 50)}`,
      )
      if (guard) console.log(`     ↳ 观测：${evidence}`)
      /* 实时日志：一行一轮，随时可读（别去戳 stdout —— 会被截断） */
      appendFileSync(
        join(ROOT, 'acc-live.txt'),
        `${new Date().toISOString().slice(11, 19)} ${mark} ${task.id} #${run} | ${row.耗时秒}s | ${detail}\n`,
        'utf8',
      )
    }
  }
} catch (e) {
  console.log('!! 驱动出错：', String(e?.message ?? e))
} finally {
  const code = summarize({ report, root: ROOT })
  app.kill()
  process.exit(code)
}
