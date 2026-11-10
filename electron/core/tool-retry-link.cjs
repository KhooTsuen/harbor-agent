function signatureOf(value) {
  if (Array.isArray(value)) return value.map(signatureOf)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, signatureOf(value[key])]),
    )
  return value
}

/** Exact replay of an unresolved failed call within this execution, never name-only. */
function retryLink(runs, call, args) {
  let signature
  try {
    signature = JSON.stringify(signatureOf(args))
  } catch {
    return {}
  }
  if (!signature) return {}
  const previous = [...runs].reverse().find((run) => {
    if (run.name !== call.name || !run.args) return false
    try {
      return JSON.stringify(signatureOf(run.args)) === signature
    } catch {
      return false
    }
  })
  return previous && previous.ok === false && !previous.pending && previous.id !== call.id
    ? { retryOf: previous.id }
    : {}
}

module.exports = { retryLink }
