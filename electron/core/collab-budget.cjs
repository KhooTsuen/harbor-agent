const { usageTotal, usageParts } = require('./budget.cjs')

/** One deadline and cumulative known usage cover all supervisor/worker rounds. */
function createBudget(input, limits) {
  const controller = new AbortController()
  const totals = new Map()
  const calls = new Map()
  const unknown = new Set()
  let reason = ''
  const cancel = (code) => {
    reason ||= code
    controller.abort()
  }
  const aborted = () => cancel('CANCELLED')
  if (input.signal?.aborted) aborted()
  else input.signal?.addEventListener('abort', aborted, { once: true })
  const timer = setTimeout(() => cancel('COLLAB_TIME_LIMIT'), limits.maxRuntime * 1000)
  timer.unref?.()
  const closePending = () => { try { input.closePending?.() } catch { /* Preserve the abort. */ } }
  controller.signal.addEventListener('abort', closePending, { once: true })
  if (controller.signal.aborted) closePending()
  const usage = () => ({
    knownTokens: [...totals.values()].reduce((sum, value) => sum + value.total, 0),
    unknownCalls: unknown.size,
  })
  function record(key, value, complete = false) {
    const count = usageTotal(value)
    if (count > 0) {
      const prior = totals.get(key) ?? { total: 0, input: 0, output: 0 }
      const parts = usageParts(value)
      totals.set(key, { total: Math.max(prior.total, count),
        input: Math.max(prior.input, parts.input), output: Math.max(prior.output, parts.output) })
      unknown.delete(key)
    } else if (complete && !totals.has(key) && ![...unknown].some(call => call.startsWith(`${key}:call:`)))
      unknown.add(key)
    if (limits.maxTokens > 0 && usage().knownTokens >= limits.maxTokens)
      cancel('COLLAB_TOKEN_LIMIT')
    if (limits.maxTokens > 0 && unknown.size) cancel('COLLAB_USAGE_UNKNOWN')
    return usage()
  }
  return {
    signal: controller.signal,
    cancel,
    reason: () => reason,
    usage,
    report: () => totals.size ? {
      total_tokens: usage().knownTokens,
      prompt_tokens: [...totals.values()].reduce((sum, value) => sum + value.input, 0),
      completion_tokens: [...totals.values()].reduce((sum, value) => sum + value.output, 0),
    } : null,
    record,
    observe: (key, emit) => Object.assign((event) => {
      if (event.type === 'collab.usage') {
        const callKey = `${key}:call:${event.call}`
        if (usageTotal(event.usage) > 0) {
          unknown.delete(callKey)
          const prior = calls.get(callKey) ?? { total: 0, input: 0, output: 0 }
          const current = usageParts(event.usage)
          calls.set(callKey, { total: Math.max(prior.total, current.total),
            input: Math.max(prior.input, current.input), output: Math.max(prior.output, current.output) })
          const parts = [...calls].filter(([id]) => id.startsWith(`${key}:call:`)).map(([, value]) => value)
          record(key, {
            total_tokens: parts.reduce((sum, value) => sum + value.total, 0),
            prompt_tokens: parts.reduce((sum, value) => sum + value.input, 0),
            completion_tokens: parts.reduce((sum, value) => sum + value.output, 0),
          })
        } else if (!calls.has(callKey)) unknown.add(callKey)
        if (limits.maxTokens > 0 && unknown.size) cancel('COLLAB_USAGE_UNKNOWN')
        return
      }
      if (event.type === 'turn_end' && event.usage) record(key, event.usage)
      emit(event)
    }, { requestId: emit.requestId, recallEvidence: emit.recallEvidence }),
    dispose: () => {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', aborted)
      controller.signal.removeEventListener('abort', closePending)
    },
  }
}

module.exports = { createBudget }
