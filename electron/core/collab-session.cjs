const { randomUUID } = require('node:crypto')
const task = require('./task.cjs')
const { scrubStorage } = require('./redact.cjs')
const { extractEvidence } = require('./collab-evidence.cjs')
const output = require('./collab-output.cjs')

/** Each stage captures its own identity; late child events cannot alter a later round. */
function createSession(input, roles, root, usageReport = () => null) {
  const emit = typeof input.emit === 'function' ? input.emit : () => {}
  const parent = require('./task-resume.cjs').openForRun({
    goal: input.goal, sessionId: input.sessionId, workdir: root,
    projectId: input.projectId, resumeTaskId: input.resumeTaskId,
    attribution: input.resumeTaskId ? undefined : { kind: 'new', reason: 'supervision' },
    mode: 'pair',
  })
  const state = {
    version: 1, mode: 'supervised', id: input.phaseKey || randomUUID(),
    taskId: parent.id, roles, phase: 'plan', status: 'running', round: 0,
    stages: [], rounds: [], limits: input.limits,
    usage: { knownTokens: 0, unknownCalls: 0 },
  }
  const usageBase = { tokens: parent.tokens || 0, input: parent.tokensIn || 0,
    output: parent.tokensOut || 0, turns: parent.turns || 0 }
  const runs = new Map()
  let active
  let finished = false
  emit({ type: 'task', taskId: parent.id, goal: input.goal })
  const publish = () => emit({ type: 'collab.phase', phase: state.phase, state: scrubStorage(state) })
  const current = (stage) => !finished && stage === active && stage.endedAt === undefined
  function accept(stage, event) {
    if (!current(stage)) return
    const type = String(event.type ?? '')
    if (type === 'task') {
      if (event.taskId && event.taskId !== parent.id) {
        stage.taskId = String(event.taskId)
        task.update(stage.taskId, { parentTaskId: parent.id })
        publish()
      }
      return
    }
    if (['phase', 'turn_start', 'turn_end'].includes(type) ||
      (type.startsWith('agent.') && !type.startsWith('agent.tool.') && type !== 'agent.retrying')) return
    if (type === 'content' || type === 'reasoning') {
      if (stage.phase === 'execute') emit({ type, text: String(event.text ?? ''), ...(type === 'content' ? { stage: 'process' } : {}) })
      return
    }
    const forwarded = { ...event }
    if (event.toolCallId) {
      const id = `${stage.key}:${event.toolCallId}`
      forwarded.toolCallId = id
      if (event.retryOf) forwarded.retryOf = `${stage.key}:${event.retryOf}`
      const run = runs.get(id) ?? { id, name: String(event.name ?? ''), args: {}, output: '', ok: false }
      if (type === 'agent.tool.started') Object.assign(run, { args: event.args ?? {}, pending: true })
      if (type === 'agent.retrying') Object.assign(run, { retryAttempt: event.attempt, pending: true })
      if (type === 'agent.tool.completed' || type === 'agent.tool.failed') {
        Object.assign(run, { ok: type !== 'agent.tool.failed' && event.ok !== false,
          output: String(event.result ?? ''), ms: event.ms })
        if (event.error) run.error = event.error
        delete run.pending
      }
      if (forwarded.retryOf) run.retryOf = forwarded.retryOf
      runs.set(id, run)
    }
    emit(forwarded)
  }
  function closeStage(status = 'completed') {
    if (!active || active.endedAt !== undefined) return
    Object.assign(active, { status, endedAt: Date.now() })
    emit({ type: 'turn_end', turn: state.stages.length })
  }
  function stage(phase, round = state.round) {
    closeStage()
    state.phase = phase
    state.status = 'running'
    state.round = round
    const role = phase === 'execute' ? 'executor' : 'planner'
    task.recordModel(parent.id, roles[role].label)
    active = { phase, role, round, status: 'running', startedAt: Date.now() }
    Object.defineProperty(active, 'key', { value: `${state.id}:${phase}:${round}:${state.stages.length}` })
    state.stages.push(active)
    emit({ type: 'turn_start', turn: state.stages.length })
    emit({ type: 'phase', phase: { plan: 'planning', execute: 'executing', review: 'verifying', deliver: 'responding' }[phase] })
    publish()
    const captured = active
    return Object.assign((event) => accept(captured, event), {
      requestId: emit.requestId,
      recallEvidence: () => current(captured) ? {
        executionId: state.id,
        runs: [...runs.values()].filter(run => run.id.startsWith(`${state.id}:execute:`)),
      } : null,
    })
  }
  function merge(phase, result) {
    if (active?.phase !== phase || finished) return
    if (result?.taskId && result.taskId !== parent.id) {
      active.taskId = result.taskId
      task.update(result.taskId, { parentTaskId: parent.id })
    }
    for (const run of result?.toolRuns ?? []) {
      const existing = runs.get(`${active.key}:${run.id}`)
      if (!existing) accept(active, { type: 'agent.tool.started', toolCallId: run.id, name: run.name, args: run.args })
      if (run.pending !== true && (!existing || existing.pending === true))
        accept(active, { type: run.ok === true ? 'agent.tool.completed' : 'agent.tool.failed',
          toolCallId: run.id, name: run.name, ok: run.ok, result: run.output,
          ms: run.ms, error: run.error, retryOf: run.retryOf })
    }
    publish()
  }
  function finish(status, details = {}) {
    Object.assign(state, details, { status })
    closeStage(status === 'completed' ? 'completed' : status)
    finished = true
    const toolRuns = scrubStorage([...runs.values()])
    const evidence = extractEvidence([...runs.values()])
    const report = output.renderRecord(state, evidence)
    const finalContent = scrubStorage(output.finalAnswer(state))
    state.finalAnswer = finalContent
    const taskStatus = status === 'completed' ? 'completed' : 'paused'
    task.finish(parent.id, { status: taskStatus, result: scrubStorage(report) })
    const usage = usageReport()
    const children = [...new Set(state.stages.map(item => item.taskId).filter(Boolean))]
      .map(id => task.get(id)).filter(Boolean)
    const sum = key => children.reduce((total, child) => total + (Number(child[key]) || 0), 0)
    task.update(parent.id, {
      tokens: usageBase.tokens + Math.max(Number(usage?.total_tokens) || 0, sum('tokens')),
      tokensIn: usageBase.input + Math.max(Number(usage?.prompt_tokens) || 0, sum('tokensIn')),
      tokensOut: usageBase.output + Math.max(Number(usage?.completion_tokens) || 0, sum('tokensOut')),
      turns: usageBase.turns + Math.max(state.stages.length, sum('turns')),
    })
    if (taskStatus === 'paused') task.update(parent.id, {
      pausedAt: Date.now(), pauseDetail: state.error?.message || '监督检查尚未通过',
      nextAction: '核对当前授权、已有成果和待解决问题后继续监督执行',
    })
    publish()
    emit({ type: 'phase', phase: status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : status === 'paused' ? 'paused' : 'failed' })
    return { ok: !state.error, accepted: status === 'completed', taskId: parent.id,
      report: scrubStorage(report), finalContent, usage, plan: state.plan, review: state.review,
      trace: scrubStorage(evidence), toolRuns, collaboration: scrubStorage(state),
      phases: state.stages.map(item => item.phase), code: state.error?.code,
      message: state.error?.message }
  }
  return { state, stage, merge, publish, finish, closeStage, runs: () => [...runs.values()] }
}

module.exports = { createSession }
