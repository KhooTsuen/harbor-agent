/** Read-only native CLI adapter for the shared supervision protocol. */
const { chatStream } = require('./codex-cli.cjs')
const protocol = require('./collab-protocol.cjs')
const prompts = require('./collab-prompts.cjs')
const failed = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })

async function callCodex(prompt, options) {
  const contexts = require('./codex-mcp-context.cjs')
  let runId = ''
  try {
    if (typeof options.recallEvidence === 'function') {
      if (!require('./codex-mcp-switch.cjs').enabled())
        return failed('CODEX_EVIDENCE_UNAVAILABLE', 'Codex 审核回取当前执行证据需要已启用的 Harbor MCP 桥；不会自动启用工具桥')
      runId = `guide_${require('node:crypto').randomUUID().replace(/-/g, '')}`
      const registered = contexts.register(runId, {
        requestId: options.emit?.requestId || options.phaseKey, sessionId: options.sessionId, collab: true,
        workdir: options.cwd ?? options.projectRoot, permission: 'readonly',
        threadSettings: { ...options.threadSettings, allowWrite: false },
        allowWrite: false, allowNetwork: false, signal: options.signal,
        confirm: options.confirm, onTool: options.emit, recallEvidence: options.recallEvidence,
      })
      if (!registered) return failed('CODEX_EVIDENCE_CONTEXT', 'Codex 审核的只读证据上下文未成功登记')
    }
    let finalMessage = ''
    /** @type {any} */
    const result = await chatStream({
      purpose: 'collab',
      disableHarborMcp: !runId,
      ...(runId ? { traceId: runId } : {}),
      messages: [{ role: 'user', content: prompt }],
      model: 'codex-cli',
      provider: options.provider ?? { kind: 'codex-cli', codexPath: '' },
      cwd: options.cwd ?? options.projectRoot,
      signal: options.signal,
      onContent: (text) => { finalMessage = String(text) },
    })
    const text = String(result?.finalContent ?? (finalMessage || result?.content) ?? '')
    const evidence = { result, usage: result?.usage ?? null, raw: text }
    if (result?.sawDone === false || result?.finishReason === 'length' || result?.truncated)
      return failed('CODEX_INCOMPLETE', 'Codex 返回未完整结束，不能采用半份规划或检查结论', evidence)
    if (!text.trim()) return failed('CODEX_EMPTY', 'Codex 没有返回内容', evidence)
    return { ok: true, text, ...evidence }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return failed('CODEX_FAILED', String(error?.message ?? error))
  } finally {
    if (runId) contexts.unregister(runId)
  }
}

async function structured(input, type) {
  const planning = type === 'plan'
  /** @type {any} */
  const result = await callCodex(planning ? prompts.planPrompt(input) : prompts.reviewPrompt(input), input)
  if (!result.ok) return result
  const parsed = protocol.parseJsonBlock(result.text)
  const normalized = planning ? protocol.normalizePlan(parsed) : protocol.normalizeReview(parsed)
  return {
    ...normalized,
    raw: result.text,
    result: result.result,
    usage: result.usage,
    ...(planning && normalized.ok ? { fields: protocol.PLAN_FIELDS } : {}),
  }
}

module.exports = {
  ...protocol,
  ...prompts,
  callCodex,
  planProjects: input => structured(input, 'plan'),
  reviewResult: input => structured(input, 'review'),
}
