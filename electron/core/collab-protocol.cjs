/** Shared, bounded model-output contract for supervision plans and reviews. */
const MAX_JSON_CHARS = 24_000
const PLAN_FIELDS = ['kind', 'problem', 'scope', 'steps', 'expected', 'verify', 'criteria']
const KINDS = new Set(['research', 'writing', 'development', 'general'])
const VERDICTS = new Set(['PASS', 'NEEDS_CHANGES', 'BLOCKED'])
const text = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '')
const failed = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })

function parseJsonBlock(value) {
  const source = typeof value === 'string' ? value : ''
  if (!source.trim()) return null
  const candidates = []
  const fenced = source.match(/```(?:json)?\s*\n([\s\S]*?)```/i)
  if (fenced?.[1]) candidates.push(fenced[1])
  const first = source.indexOf('{')
  const last = source.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1))
  for (const candidate of candidates) {
    const body = candidate.trim()
    if (!body || body.length > MAX_JSON_CHARS) continue
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* A malformed block is never treated as a natural-language verdict. */
    }
  }
  return null
}

function cleanList(value, max = 12, maxLen = 300) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const out = []
  for (const item of source) {
    const clean = text(item, maxLen)
    if (clean && !out.includes(clean)) out.push(clean)
    if (out.length >= max) break
  }
  return out
}

function normalizePlan(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return failed('PLAN_UNPARSABLE', '指导模型没有返回可解析的计划对象')
  const legacy = parsed.kind === undefined && parsed.steps === undefined && parsed.criteria === undefined
  const kind = legacy ? 'development' : text(parsed.kind, 32)
  if (!KINDS.has(kind))
    return failed('PLAN_BAD_KIND', '计划需要明确属于资料检索、写作、开发或通用任务')
  const problem = text(parsed.problem, 1200)
  const expected = text(parsed.expected, 2400)
  const verify = text(parsed.verify, 1600)
  const plan = {
    kind, problem,
    scope: cleanList(parsed.scope, 24, 500),
    steps: legacy ? [problem].filter(Boolean) : cleanList(parsed.steps, 16, 800),
    expected: expected || (legacy ? problem : ''),
    verify: verify || (legacy ? '按已有授权检查结果，未验证内容如实说明' : ''),
    criteria: legacy ? [expected || problem].filter(Boolean) : cleanList(parsed.criteria, 16, 800),
  }
  if (!plan.problem || !plan.steps.length || !plan.expected || !plan.verify || !plan.criteria.length)
    return failed('PLAN_INCOMPLETE', '计划缺少目标、执行步骤、预期结果或检查标准', { plan })
  if (kind === 'development' && !plan.scope.length)
    return failed('PLAN_SCOPE_REQUIRED', '代码修改任务需要声明允许修改的文件范围', { plan })
  return { ok: true, plan }
}

function normalizeReview(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return failed('REVIEW_UNPARSABLE', '指导模型没有返回可解析的检查结论')
  const verdict = text(parsed.verdict, 32).toUpperCase()
  if (!VERDICTS.has(verdict))
    return failed('REVIEW_BAD_VERDICT', '检查结论需要为 PASS、NEEDS_CHANGES 或 BLOCKED')
  const review = {
    verdict,
    reasons: cleanList(parsed.reasons, 16, 800),
    issues: cleanList(parsed.issues, 16, 800),
    nextSteps: cleanList(parsed.nextSteps, 16, 800),
    answer: text(parsed.answer, 16_000),
    evidence: (Array.isArray(parsed.evidence) ? parsed.evidence : []).slice(0, 24).map(ref => ({
      toolId: text(ref?.toolId, 240), claim: text(ref?.claim, 800), quote: text(ref?.quote, 1600),
      purpose: text(ref?.purpose, 24) || 'fact',
    })),
  }
  if (!review.reasons.length)
    return failed('REVIEW_INCOMPLETE', '检查结论缺少判断依据', { review })
  if (verdict === 'PASS' && !review.answer)
    return failed('REVIEW_NO_ANSWER', '检查通过但没有面向用户的最终成果', { review })
  if (verdict === 'NEEDS_CHANGES' && !review.issues.length && !review.nextSteps.length)
    return failed('REVIEW_NO_FEEDBACK', '需要补充或修改，但没有给执行者具体指令', { review })
  if (verdict === 'NEEDS_CHANGES' && !review.nextSteps.length)
    review.nextSteps = [...review.issues]
  return { ok: true, review }
}

module.exports = { PLAN_FIELDS, KINDS, VERDICTS, parseJsonBlock, cleanList, normalizePlan, normalizeReview }
