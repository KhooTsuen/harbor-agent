const planner = require('./collab-planner.cjs')
const codex = require('./collab-codex.cjs')
const { buildTask, testCommandOf } = require('./collab-task.cjs')

/** Selected roles keep their connection; delegated text never grants permission. */
function common(input, role, root, emit, phase, round = 0) {
  return {
    ...input, emit, projectRoot: root, cwd: root, workdir: root,
    recallEvidence: phase === 'plan' ? undefined : emit.recallEvidence,
    model: role.model, providerId: role.providerId,
    authorizationText: input.goal,
    threadSettings: input.threadSettings ?? {},
    attribution: { kind: 'new', reason: 'collaboration-stage' },
    traceId: `${input.phaseKey}-${phase}-${round}`,
  }
}

async function runPlan(input, root, images, emit) {
  const role = input.roles.planner
  const options = {
    ...common(input, role, root, emit, 'plan'),
    goal: input.goal, testCommand: testCommandOf(root), ...images.planner,
  }
  return role.kind === 'openai'
    ? planner.planProjects(options)
    : codex.planProjects({ ...options, provider: input.providers.planner })
}

async function runExecutor(input, root, images, plan, emit, context = {}) {
  const role = input.roles.executor
  const options = {
    ...common(input, role, root, emit, 'execute', context.round),
    plan, ...context, imageAnalysis: images.executor.imageAnalysis,
  }
  if (role.kind === 'codex-cli')
    return require('./collab-executor-codex.cjs').run({
      ...options, provider: input.providers.executor,
    })
  return require('./loop.cjs').run({
    ...options,
    goal: `监督执行：${plan.problem}`,
    history: [{
      role: 'user',
      content: require('./collab-images.cjs').contentWithImages(
        [buildTask(input.goal, plan, root, context), images.executor.imageAnalysis]
          .filter(Boolean).join('\n\n'),
        images.executor.images,
      ),
    }],
    config: planner.withModel(input.config, role.model, role.providerId),
    mode: 'pair', collabSubStep: true,
    // B reports work to A; only the supervisor decides task acceptance.
    structuredOutput: true,
  })
}

async function runReview(input, root, images, plan, trace, summary, emit, context = {}) {
  const role = input.roles.planner
  const options = {
    ...common(input, role, root, emit, 'review', context.round),
    ...images.planner, ...context, plan, trace,
    writes: trace.writes, testStatus: trace.lastTest?.status ?? '',
    testId: trace.lastTest?.testId ?? '',
    diffText: require('./collab-trace.cjs').diffOf(trace.executionId, trace.writes),
    execSummary: summary,
  }
  return role.kind === 'openai'
    ? planner.reviewResult(options)
    : codex.reviewResult({ ...options, provider: input.providers.planner })
}

/** Real interrupted output stops; a generic old development verdict goes to A for review. */
function incomplete(result) {
  if (result?.paused) return ['EXEC_PAUSED', '执行已暂停，保留现有成果与证据']
  if (result?.exhausted) return ['EXEC_EXHAUSTED', '执行达到上限，尚未交付']
  if (result?.truncated || result?.finishReason === 'length' || result?.sawDone === false)
    return ['EXEC_TRUNCATED', '执行答复未完整返回，保留记录但不采用为完整成果']
  return null
}

module.exports = {
  runPlan, runExecutor, runReview, incomplete,
  constrainReview: require('./collab-evidence.cjs').constrainReview,
}
