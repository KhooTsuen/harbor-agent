/** Read-only API guide; plans and reviews use the same protocol as the native CLI. */
const protocol = require('./collab-protocol.cjs')
const prompts = require('./collab-prompts.cjs')
const failed = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })

/** Keep each explicitly selected role on its actual connection and model. */
function withModel(config, model, providerId = '') {
  const selected = String(model ?? '').trim()
  if (!selected) return config
  const provider = providerId
    ? (config.providers ?? []).find(item => item.id === providerId && item.enabled !== false)
    : require('./config.cjs').providerForModel(selected, config)
  if (providerId && (!provider || !(provider.models ?? []).includes(selected)))
    throw new Error('所选指导/工作模型与供应商配置不匹配，请重新选择')
  return {
    ...config,
    _collabProviderId: provider?.id ?? '',
    assistant: { ...(config.assistant ?? {}), model: selected },
    router: { ...(config.router ?? {}), enabled: false },
    fallback: { ...(config.fallback ?? {}), enabled: false },
    ...(provider ? { activeProvider: provider } : {}),
  }
}

function markChildTask(taskId, message) {
  if (!taskId) return
  try {
    require('./task.cjs').update(String(taskId), { result: String(message).slice(0, 800) })
  } catch {
    /* A recording failure must not hide the actual model-output failure. */
  }
}

async function runReadOnly(input) {
  /** @type {((event: any) => void) & { requestId?: string } | undefined} */
  const emit = typeof input.emit === 'function' ? event => {
    if (event?.type !== 'content' && event?.type !== 'reasoning') input.emit(event)
  } : undefined
  if (emit) emit.requestId = input.emit.requestId
  try {
    /** @type {any} */
    const result = await require('./loop.cjs').run({
      goal: '监督执行：指导模型',
      authorizationText: input.goal,
      history: [{
        role: 'user',
        content: require('./collab-images.cjs').contentWithImages(input.prompt, input.images),
      }],
      config: withModel(input.config, input.model, input.providerId),
      workdir: input.workdir,
      sessionId: input.sessionId ?? '',
      projectId: input.projectId,
      origin: input.origin === 'edge-sidepanel' ? 'edge-sidepanel' : '',
      allowBuiltinBrowser: input.allowBuiltinBrowser === true,
      mode: 'pair',
      signal: input.signal ?? new AbortController().signal,
      confirm: input.confirm,
      emit,
      collabSubStep: true,
      structuredOutput: true,
      attribution: { kind: 'new', reason: 'collaboration-guide' },
      controls: input.controls,
      traceId: input.traceId,
      recallEvidence: input.recallEvidence,
      threadSettings: { ...input.threadSettings, allowWrite: false, useMemory: false },
    })
    const text = String(result?.finalContent ?? result?.content ?? '')
    const evidence = { result, usage: result?.usage ?? null, raw: text, taskId: result?.taskId ?? '' }
    if (result?.paused) return failed('GUIDE_PAUSED', '指导阶段已暂停，记录保留', evidence)
    if (result?.exhausted) return failed('GUIDE_EXHAUSTED', '指导阶段达到执行上限，记录保留', evidence)
    if (result?.truncated || result?.finishReason === 'length')
      return failed('GUIDE_TRUNCATED', '指导模型的结构化输出未完整返回', evidence)
    if (!text.trim()) {
      markChildTask(result?.taskId, '指导模型没有返回计划或检查结论')
      return failed('PLANNER_EMPTY', '指导模型没有返回内容', evidence)
    }
    // A loop development verdict does not determine the structure of a plan.
    return { ok: true, text, ...evidence }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return failed('PLANNER_FAILED', String(error?.message ?? error))
  }
}

async function structured(input, type) {
  const planning = type === 'plan'
  const prompt = planning ? prompts.planPrompt(input) : prompts.reviewPrompt(input)
  /** @type {any} */
  const result = await runReadOnly({ ...input, prompt, workdir: input.cwd ?? input.projectRoot })
  if (!result.ok) return result
  const parsed = protocol.parseJsonBlock(result.text)
  const normalized = planning ? protocol.normalizePlan(parsed) : protocol.normalizeReview(parsed)
  if (!normalized.ok) markChildTask(result.taskId, `${/** @type {any} */ (normalized).code}：${/** @type {any} */ (normalized).message}`)
  return {
    ...normalized,
    raw: result.text,
    result: result.result,
    usage: result.usage,
    ...(planning && normalized.ok ? { fields: protocol.PLAN_FIELDS } : {}),
  }
}

module.exports = {
  planProjects: input => structured(input, 'plan'),
  reviewResult: input => structured(input, 'review'),
  runReadOnly,
  withModel,
}
