const stages = require('./collab-stages.cjs')
const { createSession } = require('./collab-session.cjs')
const { createBudget } = require('./collab-budget.cjs')
const { extractEvidence } = require('./collab-evidence.cjs')
const gateDenied = require('./gate-denied.cjs')
const { progressKey } = require('./collab-progress.cjs')

const stopReasons = {
  CANCELLED: '已停止监督执行，已有成果与记录已保留',
  COLLAB_TIME_LIMIT: '已达到协作总时长上限，保留阶段成果，尚未完成验收',
  COLLAB_TOKEN_LIMIT: '已达到已报告 Token 上限，保留阶段成果，尚未完成验收',
  COLLAB_USAGE_UNKNOWN: '本次调用未提供用量，无法继续核对已设置的 Token 上限，已暂停',
  TOOL_DENIED: '本轮有操作未获批准，已停止自动执行；已有成果与待解决问题已保留',
}

/** Bounded automatic correction; ordinary handoffs reuse the human's authorization. */
async function perform(original, root) {
  const budget = createBudget(original, original.limits)
  const input = {
    ...original, signal: budget.signal,
    confirm: typeof original.confirm === 'function' ? async request => {
      if (budget.signal.aborted) return false
      const approved = await original.confirm(request)
      if (approved !== true && !budget.signal.aborted) budget.cancel('TOOL_DENIED')
      return approved === true
    } : undefined,
  }
  let session
  /** @type {{ round: number, status: string, summary?: string, review?: object } | undefined} */
  let currentRound
  let phase = 'plan'
  try {
    session = createSession(input, input.roles, root, () => budget.report())
    const evidence = () => extractEvidence(session.runs().filter(run =>
      !run.id.startsWith(`${session.state.id}:plan:`)))
    const stop = (code, message, status = 'blocked') => {
      if (currentRound?.status === 'running') currentRound.status = status
      session.state.usage = budget.usage()
      return session.finish(status, { error: { code, message } })
    }
    const interrupted = () => {
      const code = budget.reason()
      if (code) return stop(code, stopReasons[code],
        code === 'CANCELLED' ? 'cancelled' : code === 'TOOL_DENIED' ? 'blocked' : 'paused')
      if (input.controls?.pauseRequested?.() === true)
        return stop('PAUSED', '监督执行已暂停，已有成果与记录已保留', 'paused')
      return null
    }
    async function invoke(nextPhase, round, call) {
      phase = nextPhase
      const emit = budget.observe(`${phase}:${round}`, session.stage(phase, round))
      try {
        const result = await call(emit)
        session.merge(phase, result?.result ?? result)
        session.state.usage = budget.record(`${phase}:${round}`, result?.usage ?? result?.result?.usage, true)
        session.publish()
        return result
      } catch (error) {
        session.state.usage = budget.record(`${phase}:${round}`, null, true)
        throw error
      }
    }
    let stopped = interrupted()
    if (stopped) return stopped
    const prepared = await require('./collab-images.cjs').prepareRoles(
      input.images ?? [], input.roles, input.config, {
        allowNetwork: require('./user-constraints.cjs').allowsNetwork({
          userText: input.goal, threadAllowNetwork: input.threadSettings?.allowNetwork,
        }),
        signal: input.signal, emit: input.emit, question: input.goal,
      },
    )
    // Auxiliary image calls currently expose no usage; never count them as free.
    for (const role of ['planner', 'executor'])
      if (prepared[role].analysis)
        for (let i = 0; i < (input.images?.length ?? 0); i += 1)
          budget.record(`images:${role}:${i}`, null, true)
    stopped = interrupted()
    if (stopped) return stopped
    const images = {
      planner: { images: prepared.planner.images, imageAnalysis: prepared.planner.analysis },
      executor: { images: prepared.executor.images, imageAnalysis: prepared.executor.analysis },
    }
    const planned = await invoke('plan', 0, emit => stages.runPlan(input, root, images, emit))
    stopped = interrupted()
    if (stopped) return stopped
    if (planned.ok !== true) return stop(planned.code, planned.message, 'failed')
    session.state.plan = planned.plan
    session.publish()
    if (gateDenied.stopped(input.sessionId)) return stop('TOOL_DENIED', '本轮执行已被用户否决，停止内部交接')
    const plan = planned.plan
    let previousResult = ''
    let feedback
    const fingerprints = new Set()
    for (let round = 1; round <= input.limits.maxRounds; round += 1) {
      stopped = interrupted()
      if (stopped) return stopped
      currentRound = { round, status: 'running' }
      session.state.rounds.push(currentRound)
      const context = { round, previousResult, feedback }
      const execution = await invoke('execute', round, emit =>
        stages.runExecutor(input, root, images, plan, emit, context))
      currentRound.summary = String(execution?.finalContent ?? execution?.content ?? '').slice(0, 12000)
      stopped = interrupted()
      if (stopped) return stopped
      const unfinished = stages.incomplete(execution)
      if (unfinished) return stop(...unfinished, 'paused')
      if (gateDenied.stopped(input.sessionId)) return stop('TOOL_DENIED', '本轮执行已被用户否决，不再自动继续')
      const trace = evidence()
      const reviewed = await invoke('review', round, emit => stages.runReview(
        input, root, images, plan, trace, currentRound.summary, emit, context))
      stopped = interrupted()
      if (stopped) return stopped
      if (reviewed.ok !== true) return stop(reviewed.code, reviewed.message, 'failed')
      const review = stages.constrainReview(reviewed.review, evidence(), plan, { requireEvidence: plan.kind === 'research' })
      currentRound.review = review
      currentRound.status = review.verdict === 'PASS' ? 'completed' : 'blocked'
      session.state.review = review
      session.publish()
      if (gateDenied.stopped(input.sessionId)) return stop('TOOL_DENIED', '本轮执行已被用户否决，保留检查结果')
      if (review.verdict === 'PASS') {
        session.state.finalAnswer = review.answer
        session.stage('deliver', round)
        return session.finish('completed')
      }
      if (review.verdict === 'BLOCKED') return stop('REVIEW_BLOCKED', review.issues.join('；') || review.reasons.join('；'))
      if (round === input.limits.maxRounds) return stop('COLLAB_ROUND_LIMIT', '已达到协作轮数上限，仍有待解决问题', 'paused')
      const roundTools = trace.tools.filter(run => run.id.startsWith(`${session.state.id}:execute:${round}:`))
      const key = progressKey(currentRound.summary, review, { ...trace, tools: roundTools, kind: plan.kind })
      if (fingerprints.has(key)) return stop('COLLAB_NO_PROGRESS', '连续执行未取得新成果，已停止自动返工', 'paused')
      fingerprints.add(key)
      previousResult = currentRound.summary
      feedback = review
    }
    return stop('COLLAB_ROUND_LIMIT', '已达到协作轮数上限', 'paused')
  } catch (error) {
    const code = budget.reason() || (error?.name === 'AbortError' ? 'CANCELLED' : 'COLLAB_STAGE_FAILED')
    const status = code === 'CANCELLED' ? 'cancelled' : code === 'TOOL_DENIED' ? 'blocked' : stopReasons[code] ? 'paused' : 'failed'
    if (!session) throw error
    if (currentRound?.status === 'running') currentRound.status = status
    session.state.usage = budget.usage()
    return session.finish(status, { error: {
      code, message: stopReasons[code] || `${phase} 阶段未完成：${String(error?.message ?? error)}`,
    } })
  } finally {
    budget.dispose()
  }
}

module.exports = { perform, progressKey }
