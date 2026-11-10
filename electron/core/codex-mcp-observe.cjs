const { randomUUID } = require('node:crypto')

/** Capture the actual response while it exists; no disk-log scan or model self-report. */
function observeCalls(invoke) {
  return async (tool, args, runId = '') => {
    const entry = require('./codex-mcp-context.cjs').get(runId)
    const emit = entry?.onTool
    if (typeof emit !== 'function') return invoke(tool, args, runId)
    const toolCallId = `mcp_${randomUUID().replace(/-/g, '')}`
    const name = String(tool).replace(/^harbor_/, '')
    const startedAt = Date.now()
    const send = (event) => {
      try {
        emit(event)
      } catch {
        /* Observation cannot change tool execution. */
      }
    }
    send({ type: 'agent.tool.started', toolCallId, name, args })
    try {
      const result = await invoke(tool, args, runId)
      const ok = result.ok === true && result.payload?.toolOk !== false
      send({
        type: ok ? 'agent.tool.completed' : 'agent.tool.failed',
        toolCallId,
        name,
        ok,
        result: String(result.payload?.text ?? result.error?.message ?? ''),
        ms: Date.now() - startedAt,
      })
      return result
    } catch (error) {
      send({
        type: 'agent.tool.failed',
        toolCallId,
        name,
        ok: false,
        result: String(error?.message ?? error),
        ms: Date.now() - startedAt,
      })
      throw error
    }
  }
}

module.exports = { observeCalls }
