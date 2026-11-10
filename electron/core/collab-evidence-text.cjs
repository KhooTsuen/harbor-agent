const { cleanList } = require('./collab-protocol.cjs')
const { describeRun } = require('./collab-source-state.cjs')

/** Valid JSON under a fixed text budget; IDs survive excerpt truncation. */
function evidenceText(input) {
  const trace = input.trace ?? {}
  const tools = Array.isArray(trace.tools) ? trace.tools : []
  const sources = (trace.sources ?? []).slice(-12)
  const referenced = new Set(sources.map(source => source.toolId))
  const selected = new Set([
    ...tools.filter(run => referenced.has(run.id)),
    ...tools.filter(run => run.pending || run.ok !== true).slice(-6),
    ...tools.slice(-12),
  ])
  const payload = {
    retrieval: '摘要不是完整证据。recall({callId:"完整工具ID",offset:0,limit:12000}) 回取；recall({query:"关键词"}) 检索当前执行全部正文。未展示不等于不存在。',
    writes: cleanList(trace.writes ?? input.writes, 24, 300),
    lastTest: trace.lastTest ?? { status: input.testStatus || '未记录' },
    changedAfterTest: trace.changedAfterTest === true,
    totalTools: tools.length, omittedTools: 0,
    sources: sources.map(source => ({ ...source, snippet: String(source.snippet ?? '').slice(0, 350) })),
    catalog: tools.slice(-60).map(run => ({ callId: run.id, name: run.name, ...describeRun(run) })),
    tools: [...selected].slice(-20).map(run => ({
      id: run.id, name: run.name, ok: run.ok === true, pending: run.pending === true,
      ...describeRun(run), args: JSON.stringify(run.args ?? {}).slice(0, 800),
      output: String(run.output ?? '').slice(0, 700), excerptOnly: String(run.output ?? '').length > 700,
    })),
  }
  for (;;) {
    payload.omittedTools = tools.length - payload.tools.length
    const text = JSON.stringify(payload)
    if (text.length <= 20000) return text
    const longest = payload.tools.reduce((best, run) => run.output.length > (best?.output.length ?? 0) ? run : best, null)
    if (longest && longest.output.length > 80) {
      longest.output = longest.output.slice(0, Math.floor(longest.output.length / 2))
      longest.excerptOnly = true
    } else if (payload.catalog.length) payload.catalog.shift()
    else if (payload.tools.length) payload.tools.shift()
    else if (payload.sources.length) payload.sources.shift()
    else return JSON.stringify({ retrieval: payload.retrieval, totalTools: tools.length, omittedTools: tools.length })
  }
}

module.exports = { evidenceText }
