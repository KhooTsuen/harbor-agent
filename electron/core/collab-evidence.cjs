const traceMod = require('./collab-trace.cjs')
const { redact, scrubStorage } = require('./redact.cjs')
const { describeRun } = require('./collab-source-state.cjs')

function webUrl(value) {
  let text = String(value ?? '').trim().replace(/[\]，。；,;.]+$/, '')
  while (text.endsWith(')') && (text.match(/\)/g)?.length ?? 0) > (text.match(/\(/g)?.length ?? 0))
    text = text.slice(0, -1)
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || redact(text) !== text)
      return ''
    url.hash = ''
    return url.href
  } catch { return '' }
}

/** Only output fields written by the actual lookup tool establish source provenance. */
function observedUrls(run, output) {
  if (run.name === 'search_web') {
    // formatResults echoes the query first; a query containing a URL is not a result.
    const header = typeof run.args?.query === 'string'
      ? `搜索「${run.args.query}」的结果：`
      : output.match(/^搜索「[^\r\n]*」的结果：/)?.[0]
    if (!header || !output.startsWith(header)) return []
    return [...output.slice(header.length).matchAll(/^\d+\.[^\r\n]*\r?\n {3}(https?:\/\/\S+)[ \t]*$/gm)]
      .map(match => match[1])
  }
  if (!['browse', 'browse_nav', 'edge_read_page'].includes(run.name) || /没有可读的正文/.test(output))
    return []
  // wrapWebText records the final URL after redirects. Links inside the body are not read pages.
  const page = output.match(/^URL[：:]\s*(https?:\/\/\S+)\s*\r?\n标题[：:]/m)
  return page ? [page[1]] : []
}

/** Observed sources are lookup evidence, not claims that a website is trustworthy. */
function extractEvidence(toolRuns) {
  const runs = (Array.isArray(toolRuns) ? toolRuns : []).filter(run => run && typeof run.name === 'string')
  const trace = traceMod.extractTrace(runs)
  const sources = []
  const seen = new Set()
  for (const run of runs) {
    if (run.ok !== true || run.pending) continue
    const output = String(run.output ?? '')
    if (describeRun(run).status !== 'readable') continue
    if (run.name === 'read_file' && run.args?.path) {
      const path = String(run.args.path)
      if (!seen.has(`file:${path}`)) {
        seen.add(`file:${path}`)
        sources.push({ toolId: run.id, name: run.name, path, snippet: output.slice(0, 700) })
      }
    }
    for (const value of observedUrls(run, output)) {
      const url = webUrl(value)
      if (!url || seen.has(url)) continue
      seen.add(url)
      const position = output.indexOf(value)
      sources.push({ toolId: run.id, name: run.name, url,
        snippet: output.slice(Math.max(0, position - 180), Math.max(0, position) + 600) })
    }
  }
  // This object crosses model and persistence boundaries. Full records remain available, redacted.
  return scrubStorage({ ...trace, sources, tools: runs.map(run => ({ ...run })) })
}

function correction(review, message, blocked = false) {
  return { ...review, verdict: blocked ? 'BLOCKED' : 'NEEDS_CHANGES',
    reasons: [...(review.reasons ?? []), message],
    issues: [...(review.issues ?? []), message],
    nextSteps: [...(review.nextSteps ?? []), message] }
}

/** Checks depend on the goal category; content work does not need a project test. */
function constrainReview(review, trace, plan, options = {}) {
  const grounding = require('./collab-review-evidence.cjs').reviewEvidence(review, trace, options.requireEvidence === true)
  if (grounding) return { ...correction(review, grounding, true), answer: '' }
  if (review.verdict !== 'PASS') return review
  if ((trace.tools ?? []).some(run => run.pending))
    return correction(review, '仍有工具结果未确认，先核对实际执行结果', true)
  // The absent plan keeps the old development gate for historical callers.
  if (!plan || plan.kind === 'development') {
    const currentPass = trace.lastTest?.status === 'PASS' && trace.lastTest?.ok === true && !trace.changedAfterTest
    if (!currentPass) {
      if (options.testsProhibited === true)
        return correction(review, '用户禁止运行测试，当前改动尚未取得有效验收记录；保留成果并如实说明未验证', true)
      const message = trace.changedAfterTest
        ? '最近一次修改在验证之后，请在现有授权内验证当前版本再交付'
        : '缺少本次执行的有效项目测试通过记录，请按现有权限补充验证'
      const repairable = trace.lastTest?.status === 'FAIL' ||
        (trace.lastTest?.status === 'PASS' && trace.lastTest.ok === true && trace.changedAfterTest)
      return correction(review, message, !repairable || !plan)
    }
  }
  if (plan && !String(review.answer ?? '').trim())
    return correction(review, '缺少面向用户的实际交付内容，请整理结果')
  if (plan?.kind === 'research') {
    const sources = trace.sources ?? []
    if (!sources.some(source => source.url || source.path))
      return correction(review, '还没有实际取得的查阅资料，请检索或读取真实资料后再回答')
    const web = sources.filter(source => source.url)
    const answerUrls = new Set((String(review.answer).match(/https?:\/\/[^\s<>"`]+/g) ?? []).map(webUrl).filter(Boolean))
    if (web.length && !web.some(source => answerUrls.has(webUrl(source.url))))
      return correction(review, '最终答复缺少可对应真实检索记录的来源链接，请补上依据')
  }
  return review
}

module.exports = { extractEvidence, constrainReview }
