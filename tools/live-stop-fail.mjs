/**
 * 过程入口流光的两个「异常结束」场景（从 `e2e-process-live.mjs` 拆出来的：红线 300 行）。
 *
 * 为什么要分开两个文件而不是继续堆：主脚本已经有九种情形，再往里加就过红线；
 * 而这两个场景和「正常完成」用的是同一套判据（流光必须消失），拆出来读起来反而更清楚。
 *
 * ── 这里钉的两件事 ────────────────────────────────────────────────
 * ① **点停止 → 流光立刻消失**：停下来的那一轮没有工具调用（停在第 8 片正文之前），
 *    所以按设计**没有过程入口** ——「已中断」这三个字出现在入口上，前提是有过程可收。
 *    没入口时由 MessageItem 那句「这条回复没写完」标明未完成（见 interruptedMessage.test.tsx）。
 *    判据因此是「界面上说清了没写完」，而不是死认某一个位置的字。
 * ② **上游报错 → 也不能留下流光**：失败态显示成「正在运行」是最坏的一种谎报。
 */

/** 在 `[aria-label="侧边栏"]` 之外找界面文本（和 PROBE 一样靠 querySelector，不做全局断言） */
const readTail = `(function(){
  const m = document.querySelector('main') || document.body
  const entry = document.querySelector('button[aria-label="查看过程"]')
  return { tail: (m.innerText || '').slice(-500), entryText: entry ? entry.textContent : null }
})()`

/**
 * 跑「用户点停止」和「执行失败」两个场景。
 *
 * @param {object} ctx 主脚本的接线（ev / waitFor / shotTo / rec / setMode / sleepMs）
 * @param {object} probe 需要用的页面表达式（NEW_CHAT / fillExpr / SEND / STOP / PROBE）
 */
export async function runStopAndFail(ctx, probe) {
  const { ev, waitFor, shotTo, rec, setMode, sleepMs } = ctx
  const { NEW_CHAT, fillExpr, SEND, STOP, PROBE } = probe

  /* ── 用户点停止 ── */
  await ev(NEW_CHAT, '新建对话（停止场景）')
  await sleepMs(1000)
  await ev(fillExpr('再跑一次，我中途按停止'), '填输入框')
  await sleepMs(200)
  await ev(SEND, '点发送')
  const busy = await waitFor(PROBE, (p) => p?.liveCount > 0, 25000, '采样·停止前')
  rec('★ 停止场景：跑着时有流光', busy?.liveCount === 1, `liveCount=${busy?.liveCount}`)

  const stopped = await ev(STOP, '点停止')
  rec('★ 停止按钮可点', stopped === true, stopped ? '已点「停止生成」' : '没找到停止按钮')
  const halted = await waitFor(PROBE, (p) => p?.liveCount === 0, 20000, '采样·已停止')
  rec('★★★ 点停止后流光立即消失', halted?.liveCount === 0, `liveCount=${halted?.liveCount}`)

  const stopText = await ev(readTail, '停止态文本')
  rec(
    '★★ 停止后界面标明没写完 / 已中断（不显示成完成）',
    /没写完|已中断/.test(`${stopText?.tail ?? ''}${stopText?.entryText ?? ''}`),
    `entry=${stopText?.entryText} · 尾部含「没写完」=${/没写完/.test(stopText?.tail ?? '')}`,
  )
  rec(
    '★★ 停止后没有「N 个步骤」这种完成态说法',
    !/^\d+ 个步骤$/.test(stopText?.entryText ?? ''),
    `entryText=${stopText?.entryText}`,
  )
  await shotTo('process-live-stopped.png')

  /* ── 执行失败 ── */
  setMode({ mode: 'error' })
  await ev(NEW_CHAT, '新建对话（失败场景）')
  await sleepMs(1000)
  await ev(fillExpr('这次让上游直接报错'), '填输入框')
  await sleepMs(200)
  await ev(SEND, '点发送')
  const failed = await waitFor(
    PROBE,
    (p) => p?.liveCount === 0 && p?.entries === 0,
    40000,
    '采样·失败',
  )
  rec('★★★ 执行失败后没有残留流光', failed?.liveCount === 0, `liveCount=${failed?.liveCount}`)
  const failedText = await ev(readTail, '失败态文本')
  rec(
    '★★ 界面上确实说了失败（不是静默）',
    /失败|出错|错误|400/.test(String(failedText?.tail ?? '')),
    `尾部="${String(failedText?.tail ?? '')
      .replace(/\n/g, ' / ')
      .slice(-120)}"`,
  )
  await shotTo('process-live-failed.png')
}
