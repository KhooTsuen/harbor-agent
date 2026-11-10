const { createHash } = require('node:crypto')
const { describeRun } = require('./collab-source-state.cjs')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim()
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]))
}

/** Compare observed work, independently of reviewer wording, IDs and call order. */
function progressKey(summary, _review, trace) {
  const facts = (trace.tools ?? []).filter(run => run.name !== 'recall' && describeRun(run).status === 'readable')
    .map(run => hash({ name: run.name, args: ordered(run.args ?? {}), output: normalize(run.output) }))
  return hash({
    facts: [...new Set(facts)].sort(),
    writes: [...new Set(trace.writes ?? [])].sort(),
    // A pure writing task can make progress without a tool; research is judged by evidence.
    draft: trace.kind === 'writing' || trace.kind === 'general' ? normalize(summary) : '',
  })
}

module.exports = { progressKey }
