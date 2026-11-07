/**
 * 总结阶段：交接材料
 *
 * 总结对话**不继承工作对话的历史**（那可能是几十条消息、几万 token），只吃这一份材料。
 * 所以材料必须自己说清楚「真干了什么、哪里没干成」。
 *
 * ── 判据不看模型自述 ──────────────────────────────────────────
 * 全部来自任务台账与工具执行记录。`task-outcome.cjs` 的立身之本就是这句：
 * 「模型给的是它以为，台账记的是实际干过的」。这里沿用它，不另写一套判据。
 *
 * ── 控 token 但不漏关键项 ──────────────────────────────────────
 * 不做「整段截到 N 字」—— 那样会先把末尾的失败原因砍掉。改成**分桶按优先级取舍**：
 *
 *   P0 绝不丢：失败项（原因码 / 退出码 / 摘要）、没做完的计划项、测试结论
 *   P1 只留计数：工具调用几次、改了几个文件、跑了几条命令
 *   P2 先丢：成功工具的逐条摘要（只留名字与次数）
 *   P3 有上限：改动文件名单（前 30 + 「还有 N 个」）、命令（最后 10 条 + 「更早的略」）
 *
 * 正常一次任务产出约 1200~1800 token，比把工作历史整份重发小一个数量级。
 */

const taskOutcome = require('./task-outcome.cjs')

/** 各桶上限：**只为防病态数据**，正常任务根本碰不到 */
const MAX_FAILURES = 20
const MAX_OPEN_PLAN = 20
const MAX_FILES = 30
const MAX_COMMANDS = 10
const MAX_STEP_TEXT = 160

function clip(text, max) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 计划项形状：`plan` 是数组，元素可能是字符串或 `{ text, done }`（老任务两种都有）。
 * 认不出文字的项直接丢掉 —— 留一个空 `- ` 对总结模型没有意义。
 */
function planOf(task) {
  const raw = Array.isArray(task?.plan) ? task.plan : []
  return raw
    .map((item) => {
      if (typeof item === 'string') return { text: item, done: false }
      const text = String(item?.text ?? item?.label ?? item?.title ?? '')
      const done = item?.done === true || item?.completed === true
      return { text, done }
    })
    .filter((item) => item.text)
}

/**
 * 这一趟到底算成没成 —— **只看证据**。
 *
 *   `done`    ：没有失败、计划勾完了、测试没挂
 *   `partial` ：有失败项 / 有计划没勾 / 测试没跑过 —— 但确实干成了事
 *   `failed`  ：测试挂了，或者所有工具调用都失败
 *
 * 注意 `runs.length > 0 && failed.length === runs.length` 这条：全失败才算 fail，
 * 一次失败不算 —— 那多半是模型试错后换了做法（`partial`）。
 */
function verdictOf({ runs, failed, errors, open, tests }) {
  if (tests === 'failed') return 'failed'
  if (runs.length > 0 && failed.length === runs.length) return 'failed'
  if (failed.length > 0 || errors.length > 0 || open.length > 0) return 'partial'
  return 'done'
}

const VERDICT_LABEL = {
  done: '全部按计划完成，没有失败项。',
  partial: '部分完成 —— 有失败项或没做完的事项，下面的证据要如实汇报。',
  failed: '没有成功完成 —— 下面的证据说明卡在哪里。',
}

/**
 * 造交接材料。
 *
 * @param {{ task?: object|null, toolRuns?: Array<object>, goal?: string }} input
 * @returns {{ text: string, verdict: string, stats: object }}
 */
function buildHandoff({ task, toolRuns = [], goal = '' } = {}) {
  const runs = Array.isArray(toolRuns) ? toolRuns : []
  const errors = Array.isArray(task?.errors) ? task.errors : []
  const files = Array.isArray(task?.changedFiles) ? task.changedFiles : []
  const commands = Array.isArray(task?.commands) ? task.commands : []
  const outcome = taskOutcome.outcomeOf(task)
  const plan = planOf(task)
  const open = plan.filter((p) => !p.done)
  const failed = runs.filter((r) => r.ok === false)
  const verdict = verdictOf({ runs, failed, errors, open, tests: outcome.tests })

  const lines = []

  lines.push('## 任务')
  lines.push(`目标：${clip(task?.goal || goal, 600) || '（未记录）'}`)
  if (task?.star) lines.push(`北极星：${clip(task.star, 300)}`)
  lines.push('')

  /* ── P0：结论（含 P1 的计数） ── */
  lines.push('## 结论（由执行记录判定，不是模型自述）')
  lines.push(VERDICT_LABEL[verdict])
  lines.push(
    `工具调用 ${runs.length} 次（失败 ${failed.length} 次）；改动文件 ${files.length} 个；执行命令 ${commands.length} 条`,
  )
  if (outcome.tests !== 'none') {
    const state =
      outcome.tests === 'passed' ? '通过' : outcome.tests === 'failed' ? '**失败**' : '结果未知'
    lines.push(`最后一条测试命令：${clip(outcome.testCommand, 200)} → ${state}`)
    if (outcome.testSummary) lines.push(`  输出摘要：${clip(outcome.testSummary, 300)}`)
  }
  lines.push('')

  /* ── P0：失败项（绝不裁） ── */
  if (failed.length > 0 || errors.length > 0) {
    lines.push('## 失败项（必须如实汇报）')
    for (const run of failed.slice(-MAX_FAILURES)) {
      const code = run.error?.reasonCode ? ` · ${run.error.reasonCode}` : ''
      const exit = Number.isInteger(run.error?.exitCode) ? ` · 退出码 ${run.error.exitCode}` : ''
      const why = run.error?.message || run.output || ''
      lines.push(`- ${run.name || '工具'}${code}${exit}：${clip(why, MAX_STEP_TEXT)}`)
    }
    for (const item of errors.slice(-MAX_FAILURES)) {
      const who = clip(item?.tool || item?.kind || '错误', 40)
      lines.push(`- ${who}：${clip(item?.message ?? item, MAX_STEP_TEXT)}`)
    }
    lines.push('')
  }

  /* ── P0：没做完的（绝不裁） ── */
  if (open.length > 0) {
    lines.push('## 没做完的事项')
    for (const item of open.slice(0, MAX_OPEN_PLAN)) lines.push(`- ${clip(item.text, MAX_STEP_TEXT)}`)
    if (open.length > MAX_OPEN_PLAN) lines.push(`- …还有 ${open.length - MAX_OPEN_PLAN} 项`)
    lines.push('')
  }

  /* ── P2：工具统计（没有逐条摘要，只有次数 —— token 花在这里最不值） ── */
  const byTool = new Map()
  for (const run of runs) {
    const key = String(run.name || '未知')
    const one = byTool.get(key) ?? { ok: 0, bad: 0 }
    if (run.ok === false) one.bad += 1
    else one.ok += 1
    byTool.set(key, one)
  }
  if (byTool.size > 0) {
    lines.push('## 用过的工具')
    lines.push(
      [...byTool.entries()]
        .map(([name, c]) => `${name} ${c.ok + c.bad} 次${c.bad ? `（失败 ${c.bad}）` : ''}`)
        .join('；'),
    )
    lines.push('')
  }

  /* ── P3：改动文件（数量全给，名单有上限） ── */
  if (files.length > 0) {
    lines.push('## 改动的文件')
    lines.push(files.slice(0, MAX_FILES).join('、'))
    if (files.length > MAX_FILES) lines.push(`（还有 ${files.length - MAX_FILES} 个未列出）`)
    lines.push('')
  }

  /* ── P3：命令（最后几条 + 退出标记；更早的只报数量） ── */
  if (commands.length > 0) {
    lines.push('## 最后几条命令')
    for (const item of commands.slice(-MAX_COMMANDS)) {
      const mark = item.exitOk === true ? '✓' : item.exitOk === false ? '✗' : '?'
      lines.push(`${mark} ${clip(item.command, 160)}`)
    }
    if (commands.length > MAX_COMMANDS) {
      lines.push(`（更早的 ${commands.length - MAX_COMMANDS} 条略）`)
    }
    lines.push('')
  }

  return {
    text: lines.join('\n'),
    verdict,
    stats: {
      runs: runs.length,
      failed: failed.length,
      files: files.length,
      commands: commands.length,
      tests: outcome.tests,
      open: open.length,
    },
  }
}

module.exports = { buildHandoff, verdictOf, planOf, clip, VERDICT_LABEL }
