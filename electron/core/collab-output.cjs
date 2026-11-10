const { redact } = require('./redact.cjs')
const labels = { plan: '规划', execute: '执行', review: '检查', deliver: '交付' }

function finalAnswer(state) {
  if (state.status === 'completed')
    return redact(String(state.finalAnswer || state.review?.answer || '').trim())
  const rounds = state.rounds ?? []
  const latest = rounds.at(-1)
  const current = String(latest?.review?.answer || '').trim()
  const earlier = String(state.review?.answer ||
    [...rounds].reverse().find(round => round !== latest && round.review?.answer)?.review?.answer || '').trim()
  const answer = current || earlier
  const stale = !current && !!earlier && !!latest
  const reason = state.error?.message || state.review?.issues?.join('；') || '尚未满足完成标准'
  // B's internal execution summary stays in the folded record; only A settles a user answer.
  return redact(answer
    ? `> 本次协作尚未完成：${reason}\n\n${stale ? '上一轮 A 整理的阶段成果；后续执行尚未复核：\n\n' : ''}${answer}`
    : `本次协作停在${labels[state.phase] || '当前阶段'}：${reason}。已有过程与阶段成果已保留在协作记录中。`)
}

/** Diagnostic record stays separate from the user-facing deliverable. */
function renderRecord(state, trace) {
  const lines = [
    '监督执行记录',
    `A：${state.roles.planner.label}；B：${state.roles.executor.label}`,
    `状态：${state.status}；实际执行轮次：${state.round || 0}`,
    `目标：${state.plan?.problem || '未取得可用分派'}`,
    `任务类型：${state.plan?.kind || '未确认'}`,
    `步骤：${state.plan?.steps?.join('；') || '未形成'}`,
    `标准：${state.plan?.criteria?.join('；') || '未形成'}`,
  ]
  for (const round of state.rounds ?? []) {
    lines.push(`第 ${round.round} 轮：${round.status}`)
    if (round.review) lines.push(...(round.review.reasons ?? []), ...(round.review.issues ?? []))
    if (round.summary) lines.push(`B 阶段成果：${round.summary}`)
  }
  lines.push(`已记录改动：${trace.writes.join('；') || '无明确文件写入记录；不据此推定没有修改'}`)
  lines.push(`最后项目测试：${trace.lastTest?.status || '未运行或未取得记录'}`)
  if (state.error) lines.push(`${state.error.code}：${state.error.message}`)
  lines.push('', finalAnswer(state))
  return redact(lines.join('\n'))
}

module.exports = { finalAnswer, renderRecord }
