const caps = require('./provider-capabilities.cjs')

function forRun(payload, config, fallback) {
  const roles = [payload?.collab?.planner, payload?.collab?.executor]
  const selected = roles.find((role) => {
    const provider = config.providers?.find((item) => item.id === role?.providerId)
    return role?.kind === 'openai' && provider?.enabled !== false && role.model &&
      caps.resolve(role.model, provider?.modelCapabilities, provider).caps.vision === true
  })
  const provider = selected
    ? config.providers.find((item) => item.id === selected.providerId)
    : payload?.collab?.executor?.kind === 'codex-cli'
      ? config.providers?.find((item) => item.id === payload.collab.executor.providerId) ?? fallback
      : fallback
  return { provider, model: selected?.model ?? (provider?.kind === 'codex-cli' ? 'codex-cli' : config.assistant.model) }
}

module.exports = { forRun }
