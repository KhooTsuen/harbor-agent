/*
 * 真机端到端：过程区的**状态口径**（2026-10-22 用户给的图2 验收表）
 *
 * 链路全真，只有模型是假的（与 `e2e-process-live.mjs` 同一套脚手架）：
 *   真 Electron（源码树）→ 真界面（CDP 填框 / 发送 / 点展开）→ 真 chat handler
 *   → 真 loop.cjs → 真工具（read_file 真去读盘）→ 本机假上游
 *
 * 这里钉的是图2 表里那三行（第四行「用户停止」在 live-stop-fail.mjs）：
 *   ① 全部成功   → 入口「N 个步骤」、无红叉、每项都是「成功」
 *   ② 中途失败一次、重试成功 → 入口「N 个步骤 · 含 1 项失败」、**无红叉**，
 *      展开后两条都在、顺序是失败在前成功在后、失败那条写着真实原因
 *   ③ 工具一直失败、任务无法完成 → 入口「失败 · N 个步骤」+ 红叉
 *
 *   node tools/e2e-process-states.mjs
 */
import { sleep } from './shot/cdp.mjs'
import { start } from './live-harness.mjs'
import {
  NEW_CHAT,
  fillExpr,
  SEND,
  ENSURE_OPEN,
  PROBE_PROCESS,
  PROBE_COLORS,
  SHOW_RAW,
  STOP,
} from './live-probe.mjs'

const { ev, shotTo, waitFor, waitReady, setMode, rec, results, close } = await start({ pace: 400 })

/** 发一句话并等到「跑完」（入口在、且不再是实时任务） */
async function ask(text) {
  await ev(NEW_CHAT, '新建对话')
  await sleep(900)
  /* 新对话里不该还留着上一条消息的入口 —— 留着说明「新建」没生效，下面的判据会读错对象 */
  const cleared = await waitFor(PROBE_PROCESS, (p) => (p?.entries ?? 1) === 0, 8000, '等新对话清空')
  rec(
    '新对话是空的（不拿上一条消息的入口当判据）',
    (cleared?.entries ?? 1) === 0,
    `entries=${cleared?.entries}`,
  )
  await ev(fillExpr(text), '填输入框')
  await sleep(250)
  await ev(SEND, '点发送')
  return waitFor(
    PROBE_PROCESS,
    (p) => (p?.entries ?? 0) >= 1 && p.entryText && p.entryText !== '实时任务',
    60000,
    '等这一次跑完',
  )
}

try {
  const ready = await waitReady()
  rec('界面就绪（有输入框）', ready, ready ? 'textarea 出现' : '30 秒没等到')
  if (!ready) throw new Error('界面没起来')

  /* ── ① 全部成功 ─────────────────────────────────────────── */
  setMode({ mode: 'slow', pace: 400, pieces: 2 })
  const ok = await ask('正常跑一轮，一次都别失败')
  const okText = ok?.entryText ?? ''
  rec('★ 全成功：入口写「N 个步骤」', /^\d+ 个步骤$/.test(okText), `entryText=${okText}`)
  rec('★★ 全成功：没有失败红叉', ok?.failedMark === false, `failedMark=${ok?.failedMark}`)
  await ev(ENSURE_OPEN, '展开过程（全成功）')
  await sleep(500)
  const okOpen = await ev(PROBE_PROCESS, '采样·全成功展开')
  rec(
    '★ 过程能展开（入口点得开）',
    okOpen?.open === true,
    `open=${okOpen?.open} entries=${okOpen?.entries}`,
  )
  rec(
    '★★ 全成功：这一类调用标「已完成」，不标失败',
    JSON.stringify(okOpen?.lineStatus) === JSON.stringify(['completed']),
    `lineStatus=${JSON.stringify(okOpen?.lineStatus)} texts=${JSON.stringify(okOpen?.lineTexts)}`,
  )
  await shotTo('process-state-all-ok.png')

  /* ── ② 中途失败一次、重试成功 ────────────────────────────── */
  setMode({ mode: 'retry-ok' })
  const retry = await ask('先读一个不存在的文件，再读一个真文件')
  const retryText = retry?.entryText ?? ''
  rec(
    '★★★ 一次失败 + 重试成功：入口是「N 个步骤 · 含 1 项失败」',
    /^\d+ 个步骤 · 含 1 项失败$/.test(retryText),
    `entryText=${retryText}`,
  )
  rec(
    '★★★ 任务照样算完成：入口**不**以「失败」开头',
    !/^失败/.test(retryText),
    `entryText=${retryText}`,
  )
  rec(
    '★★★ 完成的任务不给红叉（否则等于谎报没完成）',
    retry?.failedMark === false,
    `failedMark=${retry?.failedMark}`,
  )
  await ev(ENSURE_OPEN, '展开过程（重试成功那条）')
  await sleep(600)
  const rows = await ev(PROBE_PROCESS, '采样·重试成功展开')
  console.log(`      ↳ 展开区：${rows?.paneText ?? '(没展开)'}`)
  rec(
    '★★★ 两条操作都保留，顺序是「失败」在前、「成功」在后',
    JSON.stringify(rows?.lineStatus) === JSON.stringify(['failed', 'completed']),
    `lineStatus=${JSON.stringify(rows?.lineStatus)} texts=${JSON.stringify(rows?.lineTexts)}`,
  )
  rec(
    '★★ 失败那一条给出真实原因（不是只说「1 个失败」）',
    (rows?.errors?.length ?? 0) >= 1 && (rows?.errors?.[0] ?? '').length > 4,
    `error="${rows?.errors?.[0]}"`,
  )
  /*
   * 颜色证据（代替人工看截图）：图2 要的是「成功和失败用同一套展示，
   * 不是只有失败才明显」——所以两边都得**有状态色**，而且两者不同。
   */
  const colors = await ev(PROBE_COLORS, '采样·状态颜色')
  const failedColor = colors?.rows?.find((r) => r.state === 'failed')?.color
  const doneColor = colors?.rows?.find((r) => r.state === 'completed')?.color
  rec(
    '★★ 成功与失败各有状态色、且互不相同（不是只有失败才上色）',
    Boolean(failedColor) && Boolean(doneColor) && failedColor !== doneColor,
    `失败=${failedColor} 成功=${doneColor} 全部=${JSON.stringify(colors?.rows ?? [])}`,
  )
  /*
   * 原始输出收在次级区域（图2「不要在界面中展示大段原始 JSON」）：
   * 展开区里不该直接铺 <pre>；点「查看完整输出」之后才出现。
   */
  rec(
    '★★ 展开后主区域没有直接铺原始输出（要点「查看完整输出」）',
    rows?.rawPre === false,
    `rawPre=${rows?.rawPre}`,
  )
  const showRaw = await ev(SHOW_RAW, '点「查看完整输出」')
  await sleep(300)
  const withRaw = await ev(PROBE_PROCESS, '采样·已看完整输出')
  /*
   * 两种都算对，但含义不同（分开记，别混成一条「看起来都对」）：
   *   · 有更多原文 → 按钮在，点开才铺出来
   *   · 原文就这一行 → 没有按钮（说明摘要已经等于全部输出，界面没丢信息）
   */
  if (showRaw === true) {
    rec(
      '★★ 点开「查看完整输出」才铺出原文（一个字不删）',
      withRaw?.rawPre === true,
      `rawPre=${withRaw?.rawPre}`,
    )
  } else {
    rec(
      '★★ 这次错误只有一行：不给「查看完整输出」（摘要已等于全部输出）',
      (rows?.errors?.length ?? 0) > 0 && rows.rawPre === false,
      `errors=${JSON.stringify(rows?.errors ?? [])}`,
    )
  }
  await shotTo('process-state-retry-ok.png')

  /* ── ③ 工具一直失败 → 任务无法完成 ───────────────────────── */
  setMode({ mode: 'all-fail' })
  const bad = await ask('这次让每一步都失败')
  const badText = bad?.entryText ?? ''
  rec(
    '★★★ 全都失败：入口写「失败 · N 个步骤」',
    /^失败 · \d+ 个步骤$/.test(badText),
    `entryText=${badText}`,
  )
  rec('★★★ 这才给红叉', bad?.failedMark === true, `failedMark=${bad?.failedMark}`)
  await ev(ENSURE_OPEN, '展开过程（失败那条）')
  await sleep(600)
  const badOpen = await ev(PROBE_PROCESS, '采样·失败展开')
  console.log(`      ↳ 展开区：${badOpen?.paneText ?? '(没展开)'}`)
  rec(
    '★★ 失败过程默认就是展开的（不需要用户再点一次才看到错）',
    badOpen?.open === true,
    `open=${badOpen?.open}`,
  )
  rec(
    '★★ 每一步都标了失败，真实原因可见',
    (badOpen?.statuses ?? []).length > 0 &&
      badOpen.statuses.every((s) => s === 'failed') &&
      (badOpen?.errors?.length ?? 0) > 0,
    `statuses=${JSON.stringify(badOpen?.statuses)} texts=${JSON.stringify(badOpen?.statusTexts)}`,
  )
  await shotTo('process-state-all-fail.png')

  /* ── ④ 执行中用户点停止（工具已经跑过，所以过程入口在） ───── */
  setMode({ mode: 'stop-long', pace: 900, pieces: 20 })
  await ev(NEW_CHAT, '新建对话（停止场景）')
  await sleep(900)
  await ev(fillExpr('先读目录，然后慢慢说，我中途按停止'), '填输入框')
  await sleep(250)
  await ev(SEND, '点发送')

  /* 等到「工具跑完、第 2 轮开始吐字」——这时入口已经存在且仍是实时任务 */
  const midRun = await waitFor(
    PROBE_PROCESS,
    (p) => p?.entryText === '实时任务' && (p?.entries ?? 0) >= 1,
    45000,
    '等工具跑过、正文还在出来',
  )
  rec(
    '★ 停止前：工具已跑过，入口还在（写着「实时任务」）',
    midRun?.entryText === '实时任务',
    `entryText=${midRun?.entryText}`,
  )
  await sleep(1400)
  const stopped = await ev(STOP, '点停止')
  rec('★ 停止按钮可点', stopped === true, stopped ? '已点「停止生成」' : '没找到停止按钮')

  const halted = await waitFor(
    PROBE_PROCESS,
    (p) => p?.entryText && p.entryText !== '实时任务',
    20000,
    '等停止后的入口文案',
  )
  console.log(`      ↳ 停止后入口：${halted?.entryText}`)
  await ev(ENSURE_OPEN, '展开停止后的过程')
  await sleep(400)
  const stopOpen = await ev(PROBE_PROCESS, '采样·停止后展开')
  console.log(`      ↳ 展开区：${stopOpen?.paneText ?? '(没展开)'}`)
  rec(
    '★★★ 用户停止：入口写「已中断」（不显示成完成、也不残留「实时任务」）',
    halted?.entryText === '已中断',
    `entryText=${halted?.entryText}`,
  )
  rec(
    '★★ 停止后不给「N 个步骤」这种完成态、也不给失败红叉',
    !/个步骤/.test(halted?.entryText ?? '') && halted?.failedMark === false,
    `entryText=${halted?.entryText} failedMark=${halted?.failedMark}`,
  )
  rec(
    '★★ 停之前跑成功的那一步仍在，且标着「已完成」（不因中断被抹掉）',
    (stopOpen?.lineStatus ?? []).includes('completed'),
    `lineStatus=${JSON.stringify(stopOpen?.lineStatus)} texts=${JSON.stringify(stopOpen?.lineTexts)}`,
  )
  await shotTo('process-state-stopped.png')
} catch (error) {
  console.error('E2E 失败：', error instanceof Error ? error.message : error)
  rec('E2E 跑通', false, String(error?.message ?? error))
} finally {
  close()
}

const passed = results.filter((r) => r.pass).length
console.log(
  `\n${passed === results.length ? '✅ 全过' : '❌ 有失败'}（${passed}/${results.length}）`,
)
process.exit(passed === results.length ? 0 : 1)
