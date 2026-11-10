/**
 * 任务的三种状态，**分开算、分开报**（第 24、25 项）
 *
 * ── 为什么要分 ────────────────────────────────────────────────
 * 以前只有一个 `status`（running / paused / completed / failed）和一个 `verdict`
 * （done / partial / failed / chat）。于是三件不同的事挤在同一个词里：
 *
 *   · **执行结束了没** —— 循环停了（正常收尾 / 撞预算 / 用户停 / 出错）
 *   · **交付了没**   —— 有没有给出可以当成果的正文
 *   · **验收过了没** —— 证据（测试 / 失败项 / 未完成计划）支持「做成了」吗
 *
 * 「completed」同时被当成「跑完了」和「做成了」用，就是用户看到的
 * 「明明没做完却显示完成」那一类错觉的来源。这里把三者拆开，
 * 并且**每一条都写明它的依据**，不给下游留「自己再判一次」的空间
 * （硬约束 9：跨模块的约定只有一处真相源）。
 *
 * ── 怎么用 ────────────────────────────────────────────────────
 *   const view = viewOf(task, toolRuns)
 *   view.execution.state   // 'ended' | 'running'
 *   view.delivery.state    // 'delivered' | 'partial' | 'none'
 *   view.acceptance.state  // 'passed' | 'failed' | 'unverified'
 *
 * ⚠️ 纯函数、不 require electron、不读盘 —— 自检能直接跑。
 */

/** 执行结束的几种方式。区分「它自己停的」和「人让它停的」 */
const ENDINGS = new Set(['finished', 'paused', 'budget', 'turn_limit', 'loop', 'error', 'truncated'])

function endingOf(task) {
  const status = String(task?.status ?? '')
  if (status === 'running' || status === 'waiting_user') return { state: 'running', why: '' }
  /* 明确的停止原因优先于状态词：撞预算 / 转圈 / 被截断都写得出来 */
  const reason = String(task?.pauseReason ?? '')
  if (reason === 'budget') return { state: 'ended', why: 'budget' }
  if (reason === 'loop') return { state: 'ended', why: 'loop' }
  if (reason === 'truncated') return { state: 'ended', why: 'truncated' }
  if (reason === 'turn_limit') return { state: 'ended', why: 'turn_limit' }
  if (reason === 'user') return { state: 'ended', why: 'paused' }
  if (reason === 'interrupted') return { state: 'ended', why: 'paused' }
  if (status === 'failed') return { state: 'ended', why: 'error' }
  if (status === 'completed') return { state: 'ended', why: 'finished' }
  if (status === 'paused') return { state: 'ended', why: 'paused' }
  return { state: 'ended', why: ENDINGS.has(reason) ? reason : 'finished' }
}

/**
 * 交付：**有没有可以当成果的正文**。
 *
 * ★ 顺序很重要：`result` 是收尾时写进台账的交付正文；它为空就是没交付，
 *   不拿「说过话」顶替。`partial` 专指「有成果但明确不完整」（被截断 / 部分验收）。
 */
function deliveryOf(task) {
  const text = String(task?.result ?? '').trim()
  const truncated = Boolean(task?.truncated) || String(task?.pauseReason ?? '') === 'truncated'
  if (!text) return { state: 'none', why: '没有留下交付正文' }
  if (truncated) return { state: 'partial', why: '交付正文不完整（输出被截断）' }
  return { state: 'delivered', why: '' }
}

/**
 * 验收：**证据支不支持「做成了」**。
 *
 * `unverified` 是一等状态，不是「还没算」—— 没有证据时它就是「未验收」，
 * 不许被默认成 passed（这正是「构建成功 ≠ 功能验收通过」那条规矩的落点）。
 */
function acceptanceOf(task, toolRuns = [], open = []) {
  const runs = Array.isArray(toolRuns) ? toolRuns : []
  const failed = runs.filter((r) => r && r.ok === false)
  const tests = String(task?.tests ?? task?.testStatus ?? '')
  if (tests === 'failed') return { state: 'failed', why: '测试没过' }
  if (runs.length > 0 && failed.length === runs.length) {
    return { state: 'failed', why: '所有工具调用都失败' }
  }
  if (failed.length > 0) {
    return {
      state: 'failed',
      why: `${failed.length} 个工具调用失败`,
      /* 逐条给出来源，别只说「有失败」 */
      blocking: failed.slice(0, 10).map((r) => ({ id: String(r.id ?? ''), name: String(r.name ?? '') })),
    }
  }
  if (Array.isArray(open) && open.length > 0) {
    return { state: 'unverified', why: `还有 ${open.length} 项计划没做完` }
  }
  if (runs.length === 0) return { state: 'unverified', why: '这次没有任何工具执行记录，没有可验收的证据' }
  return { state: 'passed', why: '' }
}

/**
 * 已恢复 / 仍需处理 —— 第 25 项要的「先失败后通过」那一段。
 *
 * ★ 判据只有一条：**后来的那次成功必须指向同一个东西**（同一个 id / 同一个 name +
 *   相同参数摘要）。仅仅「后面有成功」不算恢复 —— 那多半是模型换了做法，
 *   原来的问题可能一点没动。这也是项目里 tool-failure 那条「绿勾病」的反面。
 */
function recoveryOf(task, toolRuns = []) {
  const runs = Array.isArray(toolRuns) ? toolRuns : []
  const recovered = []
  const blocking = []
  for (const run of runs) {
    if (!run) continue
    if (run.ok === false) {
      /* 后面有没有「同一条」成功过 */
      const later = runs.find(
        (other) =>
          other &&
          other !== run &&
          other.ok === true &&
          (other.recoveredBy === run.id ||
            other.retryOf === run.id ||
            (run.retryOf && other.retryOf === run.retryOf && other.id !== run.id)),
      )
      if (later) recovered.push({ id: String(run.id ?? ''), name: String(run.name ?? '') })
      else blocking.push({ id: String(run.id ?? ''), name: String(run.name ?? '') })
    }
    /* 已标记恢复的也算（A09 的 retryOf / recoveredBy 是那一侧的唯一判据） */
    if (run.ok === true && run.recoveredBy) {
      recovered.push({ id: String(run.id ?? ''), name: String(run.name ?? ''), via: run.recoveredBy })
    }
  }
  return { recovered, blocking }
}

/**
 * 三态总览。
 *
 * @param {object|null} task 任务台账
 * @param {Array<object>} toolRuns 工具执行记录
 * @param {string[]} [open] 未完成的计划项
 */
function viewOf(task, toolRuns = [], open = []) {
  const execution = endingOf(task)
  const delivery = deliveryOf(task)
  const acceptance = acceptanceOf(task, toolRuns, open)
  const { recovered, blocking } = recoveryOf(task, toolRuns)
  return {
    execution,
    delivery,
    acceptance,
    recovery: { recovered, blocking },
    /* 一行给人看的总话：三件事各说各的，不合并成一个词 */
    sentence:
      `执行${execution.state === 'running' ? '还在进行' : '已结束（' + execution.why + '）'}；` +
      `交付${delivery.state === 'delivered' ? '已给出' : delivery.state === 'partial' ? '不完整' : '没有'}；` +
      `验收${acceptance.state === 'passed' ? '通过' : acceptance.state === 'failed' ? '未通过' : '未验收'}`,
  }
}

module.exports = { viewOf, endingOf, deliveryOf, acceptanceOf, recoveryOf, ENDINGS }
