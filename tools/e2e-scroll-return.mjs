/**
 * 真机验收：切走再回来，回到**同一条消息、同一行**
 *
 * 单测（`src/components/chat/__tests__/scrollReturn.test.tsx`）用的是假尺子，
 * 证明不了真实布局下的行为 —— 这里用源码树 Electron + 真 DOM 跑一遍：
 *
 *   ① A（60 条）摊开历史 → 滚到较早消息中段 → A→B→A：同一条消息、同一行
 *   ② A 在底部跟随 → A→B→A：仍在底部（不把所有对话都拽到历史）
 *   ③ A 里手动展开过程 → A→B→A：仍展开
 *   ④ 恢复后立刻用真滚轮往上滚：程序不许再拉回去
 *
 * 只碰隔离数据（`HARBOR_UNIT_TEST=1` → `data/unit-test-data`），跑完删除种子会话。
 * 种子与页面动作在 `tools/scroll-e2e-kit.mjs`（拆出去是为了守 300 行红线）。
 * 用法：node tools/e2e-scroll-return.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, sleep, findPageTarget } from './shot/cdp.mjs'
import {
  ID_A,
  ID_B,
  TITLE_A,
  TITLE_B,
  PROBE_TOP,
  PROCESS_OPEN,
  offsetOf,
  scrollToMsg,
  seedSessions,
  actions,
} from './scroll-e2e-kit.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ISO = resolve(ROOT, 'data', 'unit-test-data')
const SESS = resolve(ISO, 'sessions')
const SHOT_DIR = resolve(ROOT, 'shots', 'electron')
const PORT = 9381

const ids = seedSessions(ROOT, ISO)
const app = spawn(BIN, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: 'ignore',
  env: { ...process.env, HARBOR_UNIT_TEST: '1' },
})
const killApp = () => spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })

const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name} —— ${detail}`)
}

let cdp
try {
  await sleep(1500)
  const target = await findPageTarget(PORT, { timeoutMs: 45000 })
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await sleep(3500)

  const { ev, clickTitle, expandAll, wheel } = actions(cdp)
  const shot = async (name) => {
    mkdirSync(SHOT_DIR, { recursive: true })
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(SHOT_DIR, name), Buffer.from(s.data, 'base64'))
    console.log(`  截图 → ${resolve(SHOT_DIR, name)}`)
  }

  /* ══ 场景 1：读历史 → A→B→A ══ */
  console.log('\n① 读历史：A(60 条) 摊开 → 停在较早消息中段 → A→B→A')
  await clickTitle(TITLE_A)
  await sleep(2500)
  /*
   * 模拟用户真实动作：点**一次**「载入更早」，等它补完（按钮重现 = 补片结束）。
   * 不去追求「摊开到 60 条」：分片渲染一次只补 1~4 条，硬凑只会让脚本把时间耗在等按钮上，
   * 而判据不依赖它 —— 只要窗口比默认 24 条更深、目标在靠前处就够。
   */
  const clickedMore = await ev(
    `(function(){
      var b = [...document.querySelectorAll('button')].find(function(x){ return (x.textContent||'').indexOf("载入更早") >= 0 });
      if (!b) return 'none';
      b.click();
      return 'ok';
    })()`,
    '点一次载入更早',
  )
  if (clickedMore !== 'ok') console.log('  ⚠ 没有「载入更早」按钮：按当前窗口跑')
  for (let k = 0; k < 40; k += 1) {
    await sleep(150)
    const back = await ev(
      `(function(){
        var b = [...document.querySelectorAll('button')].find(function(x){ return (x.textContent||'').indexOf("载入更早") >= 0 });
        return b ? 'yes' : 'none';
      })()`,
      '等补片结束',
    )
    if (back === 'yes') break
  }
  const grown = await ev(PROBE_TOP, '采样条数')
  console.log(`  A 现在渲染 ${grown?.total} 条`)
  /* ★ 目标必须从**真实渲染顺序**里取：种子里的 key 不是消息 id（内核会换成 msg_…），
     拿它去查元素永远 missing，脚本就会「看起来跑了、其实没滚到该处」。 */
  const targetId = await ev(
    `(function(){ var els=[...document.querySelectorAll('[data-message-id]')]; return els[Math.min(8, els.length-1)]?.getAttribute('data-message-id') ?? null })()`,
    '取靠前的那条消息',
  )
  console.log(`  目标消息：${targetId}`)
  const moved = await ev(scrollToMsg(targetId, 180), '滚到目标上方 180px')
  await sleep(900)
  const before = await ev(PROBE_TOP, '离开前锚点')
  console.log(
    `  离开前：锚点 ${before?.id} @ ${before?.top}px，scrollTop ${before?.scrollTop}（滚到 ${moved}），渲染 ${before?.total} 条`,
  )
  await shot('scrollreturn-1-before.png')

  await clickTitle(TITLE_B)
  await sleep(1800)
  const inB = await ev(PROBE_TOP, 'B 的锚点')
  console.log(`  B 里：锚点 ${inB?.id} @ ${inB?.top}px，渲染 ${inB?.total} 条`)

  await clickTitle(TITLE_A)
  /* 等恢复：目标消息进窗口 + 偏移对上（最多 8s） */
  let after = null
  for (let i = 0; i < 40; i += 1) {
    await sleep(200)
    after = await ev(PROBE_TOP, '返回后锚点')
    const hit = await ev(offsetOf(before?.id), '目标的实时偏移')
    const snap = await ev(
      `(function(){
        var sc = document.querySelector('div[tabindex="-1"]');
        var els = [...document.querySelectorAll('[data-message-id]')];
        var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').indexOf('载入更早')>=0});
        return { n: els.length, st: sc ? Math.round(sc.scrollTop) : -1, more: b ? (b.textContent||'').trim() : 'none' };
      })()`,
      '采样',
    )
    if (i % 4 === 0 || i === 39)
      console.log(
        `    ·${i} 渲染 ${snap?.n} 条 scrollTop ${snap?.st} 目标 ${hit} 按钮「${snap?.more}」`,
      )
    if (hit !== null && Math.abs(hit - (before?.top ?? 0)) <= 2) break
  }
  const diag = await ev(
    `(function(){
      var sc = document.querySelector('div[tabindex="-1"]');
      if (!sc) return null;
      var r = sc.getBoundingClientRect();
      var els = [...document.querySelectorAll('[data-message-id]')];
      var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').indexOf('载入更早')>=0});
      return { rendered: els.length, first: els[0] && els[0].getAttribute('data-message-id'), last: els[els.length-1] && els[els.length-1].getAttribute('data-message-id'), more: b ? (b.textContent||'').trim() : 'none', viewTop: Math.round(r.top) };
    })()`,
    '返回后窗口诊断',
  )
  console.log(
    `  诊断：渲染 ${diag?.rendered} 条，首条 ${diag?.first}，末条 ${diag?.last}，按钮「${diag?.more}」`,
  )
  const afterOffset = await ev(offsetOf(before?.id), '返回后目标的偏移')
  console.log(
    `  返回后：锚点 ${after?.id} @ ${after?.top}px，目标 ${before?.id} @ ${afterOffset}px，scrollTop ${after?.scrollTop}`,
  )
  await shot('scrollreturn-2-after.png')
  rec('① A→B→A 回到同一条消息', after?.id === before?.id, `离开 ${before?.id} / 回来 ${after?.id}`)
  rec(
    '① 同一行（±2px）',
    afterOffset !== null && Math.abs(afterOffset - (before?.top ?? 0)) <= 2,
    `离开 ${before?.top}px / 回来 ${afterOffset}px`,
  )

  /* ══ 场景 4：恢复后立刻用真滚轮往上滚 ══ */
  console.log('\n④ 返回后立刻用真滚轮往上滚：程序不许把他拉回去')
  const beforeWheel = (await ev(PROBE_TOP, '滚前锚点'))?.scrollTop
  await wheel(-360)
  const afterWheel = (await ev(PROBE_TOP, '滚后锚点'))?.scrollTop
  await sleep(1200)
  const settled = (await ev(PROBE_TOP, '静置后锚点'))?.scrollTop
  rec(
    '④ 用户滚动生效且不被拉回',
    settled !== null && settled < (beforeWheel ?? 0) && Math.abs(settled - (afterWheel ?? 0)) <= 4,
    `滚前 ${beforeWheel} → 滚后 ${afterWheel} → 静置 ${settled}`,
  )

  /* ══ 场景 2：在底部跟随 → A→B→A 仍在底部 ══ */
  console.log('\n② 跟最新：A 滚到底 → A→B→A → 仍在底部')
  await ev(
    `(function(){ var sc = document.querySelector('div[tabindex="-1"]'); if (sc) sc.scrollTop = sc.scrollHeight; return 'ok' })()`,
    '滚到最底',
  )
  await sleep(600)
  await wheel(120)
  await sleep(400)
  const atBottom = await ev(PROBE_TOP, 'A 底部')
  await clickTitle(TITLE_B)
  await sleep(1500)
  await clickTitle(TITLE_A)
  await sleep(2500)
  const backBottom = await ev(PROBE_TOP, '返回后')
  rec(
    '② 跟随者回来仍在底部',
    backBottom !== null && Math.abs(backBottom.bottomGap) <= 4,
    `离开时 gap ${atBottom?.bottomGap} / 回来 gap ${backBottom?.bottomGap}（渲染 ${backBottom?.total} 条）`,
  )

  /* ══ 场景 3：过程面板手动展开 → 切换 → 仍展开 ══ */
  console.log('\n③ A 里手动展开过程 → A→B→A → 仍展开')
  /* 带思考过程的那条多半不在当前 24 条窗口里：先摊开，再从真 DOM 取它的 id
     （种子里的 key 会被内核换成 msg_…，不能拿种子值去找元素） */
  await expandAll(60)
  /*
   * ★ 摊开之后**等入口真的画出来**再往下走：`expandAll` 只保证「载入更早」变成 60 条，
   *   React 这一帧刚提交、过程入口可能还没进 DOM。第一次跑就是在这里拿了个 null，
   *   于是场景 ③ 假失败（看着像「展开状态没保留」，其实是脚本没等到）。
   */
  let diag3 = null
  let processId = null
  for (let i = 0; i < 40; i += 1) {
    processId = await ev(
      `(function(){
        var b = document.querySelector('button[aria-label="查看过程"]');
        var art = b && b.closest('[data-message-id]');
        return art ? art.getAttribute('data-message-id') : null;
      })()`,
      '带过程的那条消息 id',
    )
    if (processId) break
    await sleep(250)
  }
  /* 还没找到才打诊断：把「DOM 里到底有什么」摊开说 —— 是脚本找不到按钮，
     还是这条会话压根没渲染过程入口（那才是功能问题） */
  if (!processId) {
    diag3 = await ev(
      `(function(){
        var all = document.querySelectorAll('[data-message-id]');
        var labels = [];
        document.querySelectorAll('button').forEach(function(b){
          var a = b.getAttribute('aria-label');
          if (a && labels.indexOf(a) < 0) labels.push(a);
        });
        return { total: all.length, labels: labels };
      })()`,
      '过程入口诊断',
    )
    console.log(`  诊断：渲染 ${diag3?.total} 条；aria-label=${JSON.stringify(diag3?.labels)}`)
  }
  if (processId) await ev(scrollToMsg(processId, 160), '滚到带过程的消息')
  await sleep(900)
  const opened = await ev(
    `(function(){
      var b = document.querySelector('button[aria-label="查看过程"]');
      if (!b) return 'none';
      var was = b.getAttribute('aria-expanded');
      if (was === 'false') b.click();
      return was + '→' + b.getAttribute('aria-expanded');
    })()`,
    '展开过程',
  )
  await sleep(500)
  const openBefore = await ev(PROCESS_OPEN, '展开后状态')
  await clickTitle(TITLE_B)
  await sleep(1500)
  await clickTitle(TITLE_A)
  /* 回来时那条消息还要重新进窗口，等它出现再读 */
  let openAfter = 'none'
  for (let i = 0; i < 30; i += 1) {
    await sleep(250)
    openAfter = await ev(PROCESS_OPEN, '返回后状态')
    if (openAfter !== 'none') break
  }
  rec(
    '③ 过程展开状态保留',
    openBefore === 'true' && openAfter === 'true',
    `目标 ${processId}；点上时 ${opened}；离开前 ${openBefore} / 回来 ${openAfter}`,
  )
  await shot('scrollreturn-3-process.png')
} catch (error) {
  console.error('失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  console.log(`\n结果：${results.filter((r) => r.pass).length}/${results.length} 通过`)
  try {
    cdp?.ws.close()
  } catch {
    /* ignore */
  }
  killApp()
  for (const id of [ID_A, ID_B, ...ids]) rmSync(resolve(SESS, `${id}.jsonl`), { force: true })
}
