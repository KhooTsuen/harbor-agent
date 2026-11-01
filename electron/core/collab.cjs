/** 双模型协作：A 规划/验收，B 按批准的计划执行；写入经审批与路径校验。 */
const collabConfig = require('./collab-config.cjs')
const codex = require('./collab-codex.cjs')
const plannerMod = require('./collab-planner.cjs')
const traceMod = require('./collab-trace.cjs')
const { isAborted } = require('./abort.cjs')
function failed(code, message, extra = {}) {
  return {
    ok: /** @type {false} */ (false),
    code: String(code),
    message: String(message),
    ...extra,
  }
}
const { resolveRoles, providerForRole, testCommandOf, buildTask } = require('./collab-task.cjs')
/** @param {{ goal?: string, images?: string[], selected?: boolean, projectRoot?: string, config?: object, sessionId?: string, phaseKey?: string, origin?: string, allowBuiltinBrowser?: boolean, signal?: AbortSignal, confirm?: Function, emit?: Function, threadSettings?: object, planner?: object, executor?: object }} input */
async function runCollaboration(input = {}) {
  const {
    goal,
    images = [],
    projectRoot,
    config,
    sessionId = '',
    phaseKey = '',
    origin = '',
    allowBuiltinBrowser = false,
    signal,
    confirm,
    emit,
    threadSettings,
  } = input
  const pass = { origin, allowBuiltinBrowser } /* 透传给 planner/executor/loop；拦截在 tools/index.cjs */
  const say = typeof emit === 'function' ? emit : () => {}
  const phases = []
  /* A/B 由当前对话明确选择。 */
  const roles = resolveRoles(input.planner, input.executor)
  let plannerImages = []
  let plannerImageAnalysis = ''
  let executorImages = []
  let executorImageAnalysis = ''
  if (input.selected !== true || collabConfig.enabled() !== true)
    return failed('COLLAB_DISABLED', '当前对话未选择双模型协作，或功能已在设置中关闭')
  let plannerProvider
  let executorProvider
  try {
    plannerProvider = providerForRole(config, roles.planner)
    executorProvider = providerForRole(config, roles.executor)
  } catch (error) {
    return failed('COLLAB_SELECTION_INVALID', String(error?.message ?? error))
  }
  if (roles.planner.kind === roles.executor.kind && roles.planner.providerId === roles.executor.providerId &&
      roles.planner.model === roles.executor.model)
    return failed('COLLAB_SELECTION_INVALID', '请选择两个不同的模型')
  if (!String(goal ?? '').trim()) return failed('NO_GOAL', '没有给目标 —— 不知道该做什么')
  if (!String(projectRoot ?? '').trim()) return failed('NO_PROJECT', '没有指定项目根')
  try {
    const prepared = await require('./collab-images.cjs').prepareRoles(images, roles, config, {
      allowNetwork: require('./user-constraints.cjs').allowsNetwork({ userText: goal, threadAllowNetwork: threadSettings?.allowNetwork }),
      signal,
      emit: say,
      question: goal,
    })
    plannerImages = prepared.planner.images
    plannerImageAnalysis = prepared.planner.analysis
    executorImages = prepared.executor.images
    executorImageAnalysis = prepared.executor.analysis
  } catch (error) {
    if (error?.name === 'AbortError') return failed('CANCELLED', '读取图片时被停止')
    return failed('IMAGE_READ_FAILED', String(error?.message ?? error))
  }
  /* 沿用对话工作目录与会话授权。 */
  let rootAbs = ''
  try {
    const roots = require('./project-roots.cjs')
    const real = roots.realRoot(projectRoot)
    if (!real || roots.isForbidden(real))
      return failed('INVALID_PROJECT_ROOT', '工作目录不存在或不能作为项目目录')
    rootAbs = require('./tools/_shared.cjs').resolvePath(real, projectRoot, { sessionId })
  } catch (error) {
    return failed('ROOT_CHECK_FAILED', String((error && error.message) || error))
  }

  /* A 检查并规划。 */
  if (isAborted(signal)) return failed('CANCELLED', '开始执行前就被取消了 —— 什么都没做')
  phases.push('plan')
  say({
    type: 'collab.phase',
    phase: 'plan',
    role: 'planner',
    label: `${roles.planner.label} 正在检查项目并规划`,
  })

  let planned = null
  try {
    planned =
      roles.planner.kind === 'openai'
        ? await plannerMod.planProjects({
            goal,
            projectRoot: rootAbs,
            testCommand: testCommandOf(rootAbs),
            config,
            sessionId,
            ...pass,
            threadSettings,
            model: roles.planner.model,
            providerId: roles.planner.providerId,
            images: plannerImages,
            imageAnalysis: plannerImageAnalysis,
            signal,
            confirm,
            emit: say,
          })
        : await codex.planProjects({
            goal,
            projectRoot: rootAbs,
            testCommand: testCommandOf(rootAbs),
            cwd: rootAbs,
            provider: plannerProvider,
            imageAnalysis: plannerImageAnalysis,
            signal,
          })
  } catch (error) {
    if (error && error.name === 'AbortError') return failed('CANCELLED', '规划阶段被取消')
    return failed('PLANNER_FAILED', String((error && error.message) || error))
  }
  if (planned.ok === false) {
    say({ type: 'collab.failed', phase: 'plan', code: planned.code, message: planned.message })
    return failed(planned.code, planned.message, {
      phase: 'plan',
      raw: 'raw' in planned ? planned.raw : undefined,
    })
  }
  say({ type: 'collab.plan', plan: planned.plan })

  /* ④ 计划必须**用户点头**才往下走（用户第 3 步：计划展示给用户确认） */
  if (typeof confirm !== 'function') {
    return failed('NO_CONFIRM', '拿不到审批通道 —— 拒绝执行（不能无人确认就把计划交出去）')
  }
  const approved = await confirm({
    kind: 'collab-plan',
    name: 'collab',
    summary: `双模型协作：让 ${roles.executor.label} 按 ${roles.planner.label} 的计划改 ${planned.plan.scope.join(' / ')}`,
    impact: [
      `问题：${planned.plan.problem}`,
      `允许改：${planned.plan.scope.join(' / ')}`,
      `预期：${planned.plan.expected || '（未声明）'}`,
      `验证：${planned.plan.verify || '（未声明）'}`,
      `接下来 ${roles.executor.label} 会读文件、可能改代码（每次写入仍会单独弹审批）。`,
    ],
  })
  if (approved !== true) {
    return failed('PLAN_DENIED', '用户没有批准这个计划 —— 没有执行任何修改', { plan: planned.plan })
  }
  if (isAborted(signal)) return failed('CANCELLED', '批准之后、执行之前被取消 —— 没有修改任何文件')

  /* ⑤ 阶段二：交给 B（工作模型）执行。openai 走 loop（四道闸全在）；codex-cli 走 MCP 桥 */
  phases.push('execute')
  say({
    type: 'collab.phase',
    phase: 'execute',
    role: 'executor',
    label: `${roles.executor.label} 正在按计划执行`,
  })

  let execResult = null
  try {
    if (roles.executor.kind === 'codex-cli') {
      execResult = await require('./collab-executor-codex.cjs').run({
        goal,
        imageAnalysis: executorImageAnalysis,
        plan: planned.plan,
        projectRoot: rootAbs,
        config,
        sessionId,
        ...pass,
        phaseKey,
        provider: executorProvider,
        signal,
        confirm,
        emit: say,
      })
    } else {
      const loop = require('./loop.cjs')
      execResult = await loop.run({
        /* ★ goal 只是台账用的标题；真正给模型的是 history（见 loop-run.cjs） */
        goal: `双模型协作：${planned.plan.problem}`,
        history: [{ role: 'user', content: require('./collab-images.cjs').contentWithImages(
          [buildTask(goal, planned.plan, rootAbs), executorImageAnalysis].filter(Boolean).join('\n\n'), executorImages) }],
        config: plannerMod.withModel(config, roles.executor.model, roles.executor.providerId),
        workdir: rootAbs,
        mode: 'pair',
        sessionId,
        ...pass,
        /* ★ runLoop 会直接读 `signal.aborted`；外面没给（脚本 / 自检）时也得有一个
           —— 与 `subagent.cjs:197` 同一个口径，别让这里成为唯一的空指针入口。 */
        signal: signal ?? new AbortController().signal,
        confirm,
        emit: say,
        threadSettings: threadSettings ?? {},
      })
    }
  } catch (error) {
    if (error && error.name === 'AbortError')
      return failed('CANCELLED', '执行阶段被取消', { plan: planned.plan })
    return failed('EXEC_FAILED', String((error && error.message) || error), { plan: planned.plan })
  }

  const trace = traceMod.extractTrace(execResult?.toolRuns)
  say({ type: 'collab.executed', trace, content: String(execResult?.content ?? '') })

  /* ⑥ 阶段三：Codex 独立验收（拿的是真实痕迹，不是执行者的自述） */
  if (isAborted(signal)) {
    return failed('CANCELLED', '执行完了但验收前被取消 —— 修改已落盘，可用恢复点退回', {
      plan: planned.plan,
      trace,
    })
  }
  phases.push('review')
  say({
    type: 'collab.phase',
    phase: 'review',
    role: 'planner',
    label: `${roles.planner.label} 正在验收结果`,
  })

  let reviewed = null
  try {
    const reviewInput = {
      goal,
      plan: planned.plan,
      writes: trace.writes,
      testStatus: trace.lastTest?.status ?? '',
      testId: trace.lastTest?.testId ?? '',
      diffText: traceMod.diffOf(trace.executionId, trace.writes),
      execSummary: String(execResult?.content ?? ''),
      cwd: rootAbs,
      signal,
    }
    reviewed =
      roles.planner.kind === 'openai'
        ? await plannerMod.reviewResult({
            ...reviewInput,
            config,
            sessionId,
            threadSettings,
            model: roles.planner.model,
            providerId: roles.planner.providerId,
            images: plannerImages,
            imageAnalysis: plannerImageAnalysis,
            confirm,
            emit: say,
          })
        : await codex.reviewResult({
            ...reviewInput,
            provider: plannerProvider,
          })
  } catch (error) {
    if (error && error.name === 'AbortError')
      return failed('CANCELLED', '验收阶段被取消', { plan: planned.plan, trace })
    return failed('PLANNER_FAILED', String((error && error.message) || error), {
      phase: 'review',
      plan: planned.plan,
      trace,
    })
  }
  if (reviewed.ok === false) {
    say({ type: 'collab.failed', phase: 'review', code: reviewed.code, message: reviewed.message })
    return failed(reviewed.code, reviewed.message, {
      phase: 'review',
      plan: planned.plan,
      trace,
      raw: 'raw' in reviewed ? reviewed.raw : undefined,
    })
  }

  /* 汇报 A/B 的真实执行结果。 */
  const report = traceMod.renderReport({
    plan: planned.plan,
    review: reviewed.review,
    trace,
    phases,
    plannerLabel: roles.planner.label,
    executorLabel: roles.executor.label,
  })
  say({ type: 'collab.result', report, review: reviewed.review, plan: planned.plan, trace })

  return {
    ok: /** @type {true} */ (true),
    plan: planned.plan,
    trace,
    review: reviewed.review,
    report,
    phases,
    /* 验收通过 = Codex 说 PASS。**这个词只来自它**，不由本文件推断 */
    accepted: reviewed.review.verdict === 'PASS',
  }
}

module.exports = { runCollaboration, buildTask, testCommandOf }
