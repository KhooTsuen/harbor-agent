/*
 * 工具选择 A/B（CE-012 / P3 工具 Schema 瘦身）
 *
 * 测的是：压缩工具 description 之后，模型「选工具」有没有变差。
 *
 * ★ 为什么必须用**真模型**：选工具是**模型的行为**。假上游（tools/fake-upstream.mjs）
 *   是死规则 —— 它根本不读 description，两组跑出来必然一模一样，A/B 会**假绿**。
 *   所以这里直接连真 provider（用 app 自己 data/ 里的凭证），只驱动真实的界面链路。
 *
 * 跑法（A 组 = 旧 desc / B 组 = 新 desc）：
 *   node tools/ab-tool-choice.mjs --label=old      # 先在旧 desc 的代码上跑
 *   node tools/ab-tool-choice.mjs --label=new      # 再在新 desc 上跑
 *   node tools/ab-tool-choice.mjs --compare=old,new
 *
 * 判据：读**新会话文件**里 assistant 的 `toolRuns[0].name`（磁盘事实，不看界面文本）。
 * ⚠️ 它连的是**真 provider**：会真的花钱（每次几分钱）。跑完把本次新建的会话删掉。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, sleep, findPageTarget, evaluate } from './shot/cdp.mjs'
import { autoAnswerCards } from './shot/cards.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const SESS = resolve(ROOT, 'data', 'sessions')
const PORT = Number(process.env.AB_PORT ?? 9381)
const argOf = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d
const LABEL = argOf('label', 'run')
const OUT = resolve(ROOT, 'tmp', `ab-${LABEL}.json`)

/* 场景：每个都「该用某个工具」。期望写的是**首选**工具（模型不调工具也算一种结果） */
const SCENARIOS = [
  { prompt: 'React 19 有哪些新特性？', expect: 'search_web' },
  { prompt: '打开 https://example.com 看看写了什么', expect: 'browse' },
  { prompt: '帮我查一下 npm 上 express 的最新版本', expect: 'search_web' },
  { prompt: 'https://www.iana.org/ 这个页面的标题是什么？', expect: 'browse' },
  { prompt: '我想把这个项目大改一下，但还没想好方向', expect: 'ask_user' },
  { prompt: 'Vite 6 相比 5 有什么变化？我记不清了', expect: 'search_web' },
]

/*
 * 澄清卡上「默认选项」的**可访问标记** —— ClarifyCard 只给默认那个选项加这句
 * （`src/components/chat/ClarifyCard.tsx:244`）。用它当 `choose`：点的一定是默认项，
 * 不是随机项（A/B 要的是「卡不卡住」的对照，随机选会往结果里灌噪声）。
 */
const DEFAULT_MARKER = '没收到回答就按它来'

const NEW_CHAT = `(function(){const re=/^新建对话/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`
const fill = (t) =>
  `(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(t)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`
const SEND = `(function(){const re=/发送消息/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`

/** 读一个会话文件里**第一条带工具调用**的 assistant 的工具名（没有就按纯文字/无 assistant 判） */
function firstToolOf(file) {
  let lines = []
  try {
    lines = readFileSync(resolve(SESS, file), 'utf8').trim().split(/\r?\n/)
  } catch {
    return { tool: '', note: '读不到' }
  }
  let sawText = false
  for (const line of lines) {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    if (m.role !== 'assistant') continue
    const t = Array.isArray(m.toolRuns) ? m.toolRuns : []
    if (t.length) return { tool: String(t[0].name ?? ''), note: JSON.stringify(t[0].summary ?? '').slice(0, 60) }
    /*
     * ★ 别在第一条纯文字 assistant 上就收工：模型常常**先回一句话再调工具**
     *   （实测：「打开 iana.org」那条，第一条是文字、browse 在第二条）。
     *   旧写法在这里 return「未调工具」，把「选了 browse」误判成「没选」。
     */
    if (typeof m.content === 'string' && m.content.trim()) sawText = true
  }
  return { tool: sawText ? '（未调工具）' : '（无 assistant）', note: '' }
}

/** 读一个会话文件里**所有** assistant 的工具调用名（诊断：看清整条链路到底调了什么） */
function allToolsOf(file) {
  const names = []
  let lines = []
  try {
    lines = readFileSync(resolve(SESS, file), 'utf8').trim().split(/\r?\n/)
  } catch {
    return names
  }
  for (const line of lines) {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    if (m.role !== 'assistant') continue
    for (const x of Array.isArray(m.toolRuns) ? m.toolRuns : []) names.push(String(x.name ?? ''))
  }
  return names
}

const before = new Set(readdirSync(SESS).filter((f) => f.endsWith('.jsonl')))
const app = spawn(BIN, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
})
const killApp = () => spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })

const results = []
let cdp
try {
  await sleep(1500)
  const target = await findPageTarget(PORT, { timeoutMs: 45000 })
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const ev = (expr, label) => evaluate(cdp, expr, { label })
  for (let i = 0; i < 60; i += 1) {
    if (await ev(`!!document.querySelector('textarea')`, '等输入框')) break
    await sleep(500)
  }

  for (const [i, sc] of SCENARIOS.entries()) {
    await ev(NEW_CHAT, '新建对话')
    await sleep(1000)
    await ev(fill(sc.prompt), '填输入框')
    await sleep(300)
    await ev(SEND, '发送')
    /*
     * 等新会话文件出现，且它里面已经有 assistant 的结论。
     * ★ 途中若弹出交互卡（ask_user 澄清卡 / 权限确认卡 / 复核卡），脚本自己点掉 ——
     *   不点的话对话卡在半路，后面的场景也会被带歪（2026-10-14 实测的盲区）。
     *   每轮都调一次：没卡时 autoAnswerCards 立刻返回，有卡才动手。
     */
    let got = null
    const cards = []
    /* 90 秒：search_web 后端若不通会卡 ~20 秒再失败，60 秒会把「慢」误判成「没选对」 */
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      const ans = await autoAnswerCards(ev, { choose: DEFAULT_MARKER, timeoutMs: 3000 })
      if (ans.handled > 0) cards.push(...ans.clicks.map((c) => c.text))
      const fresh = readdirSync(SESS)
        .filter((f) => f.endsWith('.jsonl') && !before.has(f))
        .sort()
      if (fresh.length) {
        /* ★ 只算一次：`pop()` 会改数组，两次 pop 会拿到**两个不同文件**（踩过） */
        const f = fresh[fresh.length - 1]
        const r = firstToolOf(f)
        if (r.tool && r.tool !== '（无 assistant）') {
          got = { file: f, ...r, all: allToolsOf(f) }
          break
        }
      }
      await sleep(800)
    }
    const hit = got ? got.tool === sc.expect : false
    results.push({
      i: i + 1,
      prompt: sc.prompt,
      expect: sc.expect,
      got: got?.tool ?? '（超时）',
      hit,
      cards,
      all: got?.all ?? [],
    })
    console.log(
      `  ${hit ? '✓' : '✗'} [${i + 1}] 期望 ${sc.expect} / 实际 ${got?.tool ?? '（超时）'}` +
        (got?.all?.length ? ` [全部: ${got.all.join(',')}]` : '') +
        ` —— ${sc.prompt}` +
        (cards.length ? `（自动点卡：${cards.join(' → ')}）` : ''),
    )
    /* 连续两次拿不到结果就停：多半是凭证 / 网络不通，再跑下去只是白等 */
    if (results.filter((r) => r.got === '（超时）').length >= 2) {
      console.log('  ⚠ 连续超时 → 提前停（先查凭证 / 网络）')
      break
    }
  }
} catch (error) {
  console.error('A/B 跑失败：', error instanceof Error ? error.message : error)
} finally {
  try {
    cdp?.ws.close()
  } catch {
    /* ignore */
  }
  killApp()
}

mkdirSync(resolve(ROOT, 'tmp'), { recursive: true })
writeFileSync(OUT, JSON.stringify({ label: LABEL, results }, null, 2))

/* 清理：删掉本次跑出来的新会话（只删**这次新建的**，旧的一个不动） */
const after = readdirSync(SESS).filter((f) => f.endsWith('.jsonl'))
const added = after.filter((f) => !before.has(f))
for (const f of added) {
  try {
    rmSync(resolve(SESS, f), { force: true })
  } catch {
    /* ignore */
  }
}
console.log(`\n结果 → ${OUT}`)
console.log(`清理：删掉本次新建会话 ${added.length} 个`)
const correct = results.filter((r) => r.hit).length
console.log(`选对 ${correct}/${results.length}`)
process.exit(0)
