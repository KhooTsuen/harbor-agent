/*
 * 真机端到端：过程入口「实时任务」的流光（2026-10-21 用户给的视觉口径）
 *
 * 链路全真，只有模型是假的：
 *   真 Electron（源码树）→ 真界面（CDP 填输入框 / 点发送 / 点停止）→ 真 chat handler
 *   → 真 loop.cjs → 真 HTTP → 本机假上游（tools/live-fake-upstream.mjs）
 * 脚手架（隔离数据 / 起进程 / 连 CDP / 截图）在 tools/live-harness.mjs。
 *
 * 判据不是「类名挂上了」，而是**计算样式 + 动画真的在跑**：
 *   · 运行中：`.process-live` 恰好 1 个、文字是「实时任务」、animation-name 是
 *     process-live-sweep、2.4s、`background-clip: text`、填充透明、
 *     **两次采样的 background-position 不同**（真在动）、入口宽度不随过程增长而变
 *   · 运行中展开：入口继续流光，展开区里有「现在在干什么」
 *   · 关动效 / 系统「减少动态」：降级成静态文字（渐变也撤掉，不留半亮半暗）
 *   · 正常完成：流光消失（不是晚一帧），入口变「N 个步骤」，正文还在
 *   · 用户停止：流光消失，入口写「已中断」
 *   · 执行失败：流光消失（失败不能显示成还在跑）
 *   · 切到别的对话再切回来 / 刷新重开：都不播运行中动画
 *
 *   node tools/e2e-process-live.mjs
 */
import { sleep } from './shot/cdp.mjs'
import { start } from './live-harness.mjs'
import {
  NEW_CHAT,
  fillExpr,
  SEND,
  STOP,
  TOGGLE,
  PROBE,
  setAnimations,
  clickNeighbour,
} from './live-probe.mjs'
import { runStopAndFail } from './live-stop-fail.mjs'

const {
  ev,
  shotTo,
  waitFor,
  waitReady,
  setMode,
  rec,
  results,
  close,
  reload,
  emulateReduce,
  clearEmulation,
} = await start({ pace: 1400 })

/* 只在这一轮验收里用的小工具，留在主脚本比塞进脚手架更清楚 */
const sleepMs = (ms) => sleep(ms)

try {
  const ready = await waitReady()
  rec('界面就绪（有输入框）', ready, ready ? 'textarea 出现' : '30 秒没等到')
  if (!ready) throw new Error('界面没起来')

  /* ── 一次能跑完的正常回合 ─────────────────────────────── */
  await ev(NEW_CHAT, '新建对话')
  await sleepMs(1000)
  const typed = await ev(fillExpr('随便说一句，我看看过程区'), '填输入框')
  rec('输入框可写', typed === '随便说一句，我看看过程区'.length, `写入 ${typed} 字`)
  await sleepMs(300)
  await ev(SEND, '点发送')

  const running = await waitFor(PROBE, (p) => p?.liveCount > 0, 25000, '采样·运行中')
  rec('★ 运行中入口有流光', running?.liveCount === 1, `liveCount=${running?.liveCount}`)
  rec(
    '★★ 流光只挂入口那一句（不是整行 / 正文）',
    running?.liveCount === 1,
    `共 ${running?.liveCount} 处`,
  )
  rec(
    '★★ 文字是「实时任务」，不报步骤 / 用时',
    running?.liveText === '实时任务',
    `liveText=${running?.liveText}`,
  )
  rec(
    '★★★ 计算样式：process-live-sweep / 2.4s / clip=text / 填充透明',
    running?.animationName === 'process-live-sweep' &&
      running?.duration === '2.4s' &&
      String(running?.clip).includes('text') &&
      /rgba\(0, 0, 0, 0\)|transparent/.test(String(running?.fill)),
    `name=${running?.animationName} dur=${running?.duration} clip=${running?.clip} fill=${running?.fill}`,
  )
  rec(
    '★★ 没有给文字加阴影 / 光晕',
    running?.textShadow === 'none',
    `text-shadow=${running?.textShadow}`,
  )

  /* 真在动：裁入口放大连拍三张（给人工看图），同时比两次 background-position */
  await shotTo('process-live-entry-frame1.png', running?.entryRect)
  await sleepMs(400)
  const mid = await ev(PROBE, '采样·运行中2')
  await shotTo('process-live-entry-frame2.png', mid?.entryRect)
  await sleepMs(400)
  const moved = await ev(PROBE, '采样·运行中3')
  await shotTo('process-live-entry-frame3.png', moved?.entryRect)
  await shotTo('process-live-running.png')
  rec(
    '★★★ 动画真的在动（background-position 两次不同）',
    Boolean(running?.bgPos) && running.bgPos !== moved?.bgPos,
    `${running?.bgPos} → ${moved?.bgPos}`,
  )
  rec(
    '★★ 入口宽度不随过程增长改变（两次采样相同）',
    typeof running?.width === 'number' && Math.abs(running.width - (moved?.width ?? -1)) < 1,
    `${running?.width} → ${moved?.width}`,
  )

  /* ── 运行中展开 ── */
  await ev(TOGGLE, '展开入口')
  await sleepMs(400)
  const opened = await ev(PROBE, '采样·已展开')
  rec(
    '★★ 展开后过程可见（[data-process-open]）',
    opened?.expanded === true,
    `expanded=${opened?.expanded}`,
  )
  rec('★★ 展开时入口照样流光', opened?.liveCount === 1, `liveCount=${opened?.liveCount}`)
  rec(
    '★★ 展开区里能看到「现在在干什么」',
    opened?.hasActivity === true,
    `activity=${opened?.hasActivity}`,
  )
  await shotTo('process-live-running-expanded.png')

  /* ── 两条关动效的路径 ── */
  await ev(setAnimations(false), '设置里关动效')
  await sleepMs(200)
  const off = await ev(PROBE, '采样·关动效')
  rec(
    '★★ 关动效后：动画停、渐变撤掉、文字回到普通填充色',
    off?.animationName === 'none' &&
      String(off?.bgImage) === 'none' &&
      !/rgba\(0, 0, 0, 0\)/.test(String(off?.fill)),
    `name=${off?.animationName} bgImage=${off?.bgImage} fill=${off?.fill}`,
  )
  await shotTo('process-live-animations-off.png')
  await ev(setAnimations(true), '恢复动效')
  await sleepMs(200)
  const back = await ev(PROBE, '采样·恢复动效')
  rec(
    '★★ 恢复动效后流光回来',
    back?.liveCount === 1 && back?.animationName === 'process-live-sweep',
    `name=${back?.animationName}`,
  )

  await emulateReduce()
  const reduced = await ev(PROBE, '采样·减少动态')
  rec(
    '★★ 系统「减少动态」：不播动画、渐变撤掉',
    reduced?.reduce === true &&
      reduced?.animationName === 'none' &&
      String(reduced?.bgImage) === 'none',
    `reduce=${reduced?.reduce} name=${reduced?.animationName} bgImage=${reduced?.bgImage}`,
  )
  await shotTo('process-live-reduced-motion.png')
  await clearEmulation()

  /* ── 正常完成 ── */
  const done = await waitFor(
    PROBE,
    (p) => p?.liveCount === 0 && /个步骤/.test(p?.entryText ?? ''),
    90000,
    '采样·已完成',
  )
  rec(
    '★★★ 结束后流光消失（.process-live 一个都不剩）',
    done?.liveCount === 0,
    `liveCount=${done?.liveCount}`,
  )
  rec(
    '★★ 结束态入口是静态「N 个步骤」',
    /^\d+ 个步骤$/.test(done?.entryText ?? ''),
    `entryText=${done?.entryText}`,
  )
  await sleepMs(600)
  const after = await ev(PROBE, '采样·结束后0.6s')
  rec(
    '★★ 再等 0.6 秒仍然没有流光（不是晚一帧才停）',
    after?.liveCount === 0,
    `liveCount=${after?.liveCount}`,
  )
  rec(
    '★★ 正文照常显示（流光没吞掉正文）',
    (after?.bodyText ?? '').length > 0,
    `body="${after?.bodyText}"`,
  )
  await shotTo('process-live-done.png')

  /* ── 切到别的对话再切回来（表里的「切换对话再回来」）── */
  const away = await ev(NEW_CHAT, '切走（新建对话）')
  await sleepMs(1500)
  const awayProbe = await ev(PROBE, '采样·别的对话')
  rec(
    '★ 能切走（新建了一条空对话）',
    away === true && (awayProbe?.entries ?? 0) === 0,
    `entries=${awayProbe?.entries}`,
  )
  const backHit = await ev(clickNeighbour, '切回最近的历史对话')
  const back2 = await waitFor(PROBE, (p) => (p?.entries ?? 0) >= 1, 20000, '采样·切回来')
  rec(
    '★ 能切回历史对话',
    backHit === true && (back2?.entries ?? 0) >= 1,
    `entries=${back2?.entries}`,
  )
  rec('★★ 切回历史后没有残留流光', back2?.liveCount === 0, `liveCount=${back2?.liveCount}`)
  rec(
    '★★ 切回来的入口是静态状态（绝不写「实时任务」）',
    (back2?.entryText ?? '') !== '实时任务',
    `entryText=${back2?.entryText}`,
  )
  await shotTo('process-live-thread-switch.png')

  /* ── 刷新重开（等于关掉再打开历史）── */
  await reload()
  await sleepMs(4000)
  /*
   * 刷新后落在哪条会话**不稳定**（取决于落盘的 activeThreadId / 最近顺序），
   * 所以不能死认「一定停在刚才那条」：落空就顺着侧边栏切过去，直到看见有过程的
   * 那条为止。判据关心的是「历史记录里那条入口还是不是静态的」，不是「默认停在哪」。
   */
  let reopened = await waitFor(PROBE, (p) => (p?.entries ?? 0) >= 1, 8000, '采样·重开')
  for (let hop = 0; hop < 3 && (reopened?.entries ?? 0) === 0; hop += 1) {
    const moved = await ev(clickNeighbour, `刷新后切到第 ${hop + 1} 条历史`)
    if (moved !== true) break
    reopened = await waitFor(PROBE, (p) => (p?.entries ?? 0) >= 1, 8000, `采样·重开${hop + 2}`)
  }
  rec(
    '★★ 重开历史后入口还在（记录读得出来）',
    (reopened?.entries ?? 0) >= 1,
    `entries=${reopened?.entries}`,
  )
  rec('★★★ 重开历史不播运行中动画', reopened?.liveCount === 0, `liveCount=${reopened?.liveCount}`)
  rec(
    '★★ 重开历史入口是静态状态（「N 个步骤」，不是实时任务）',
    /个步骤|查看过程|已中断|失败/.test(reopened?.entryText ?? ''),
    `entryText=${reopened?.entryText}`,
  )
  await shotTo('process-live-history-reopen.png')

  /* ── 两个异常结束场景（停止 / 失败）住在 live-stop-fail.mjs ── */
  await runStopAndFail(
    { ev, waitFor, shotTo, rec, setMode, sleepMs },
    { NEW_CHAT, fillExpr, SEND, STOP, PROBE },
  )
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
