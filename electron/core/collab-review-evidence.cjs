const { describeRun } = require('./collab-source-state.cjs')

/** Grounded quotes prove observation, not the truth of every inference about them. */
function reviewEvidence(review, trace, required = false) {
  const refs = Array.isArray(review.evidence) ? review.evidence : []
  if (required && !refs.length && (trace.tools ?? []).length)
    return '审核没有绑定实际工具证据；先回取原文，不能把摘要缺失当作 B 未读取。'
  if (required && review.verdict === 'PASS' && !refs.some(ref => !ref.purpose || ref.purpose === 'fact'))
    return '资料审核通过需要绑定实际事实依据，不能只有执行成功或失败的记录。'
  for (const ref of refs) {
    const run = (trace.tools ?? []).find(item => item.id === ref.toolId)
    if (!run) return '审核引用了不存在或不属于本次执行的工具 ID。'
    const state = describeRun(run)
    const quote = String(ref.quote ?? '').trim()
    const output = String(run.output ?? '')
    const purpose = ref.purpose || 'fact'
    if (!['fact', 'execution'].includes(purpose) || !String(ref.claim ?? '').trim())
      return '审核引用缺少对应判断，或没有区分事实依据与执行情况。'
    if (state.status === 'pending') return '审核引用的工具仍未结束，不能提前认定执行结果。'
    if (purpose === 'execution' && state.status === 'empty' && !quote && !output.trim()) continue
    if (quote.length < 8 || !output.includes(quote))
      return '审核引用没有对应的逐字原文，请按实际工具 ID 回取后核对。'
    if (purpose === 'execution') continue
    if (state.status !== 'readable')
      return '空结果、失败、拒绝访问和查询回显只能说明执行情况，不能作为事实正文依据。'
    const queryHeader = run.name === 'search_web' ? output.match(/^搜索「[^\r\n]*」的结果：/)?.[0] : ''
    if (quote.split(/\r?\n/).every(line => !line.trim() || /^===\s/.test(line)) ||
      (queryHeader && output.indexOf(quote) < queryHeader.length))
      return '审核把搜索查询或脚本标题回显当成了查证结果。'
  }
  return ''
}

module.exports = { reviewEvidence }
