const fs = require('node:fs')
const config = require('./config.cjs')
const collab = require('./collab-config.cjs')

/** Read configuration and launcher metadata; this does not launch or authenticate a model. */
function status() {
  const cfg = config.get()
  const connections = {}
  const candidates = []
  const bridge = require('./codex-mcp-switch.cjs').enabled() === true
  for (const provider of cfg.providers ?? []) {
    const kind = provider.kind ?? 'openai'
    let ready = provider.enabled === true
    let reason = ready ? '' : '此连接未启用'
    if (ready && kind === 'codex-cli') {
      const launcher = require('./codex-run.cjs').resolveLauncher(provider.codexPath)
      ready = Boolean(launcher && fs.existsSync(launcher))
      reason = ready ? '启动器已找到；登录与实际调用尚未核验' : '没有找到所选 Codex CLI 启动器'
    } else if (ready) {
      ready = config.hasKey(provider) === true && Boolean(provider.baseUrl)
      if (!ready) reason = '此连接缺少地址或可用凭据'
    }
    connections[provider.id] = {
      ready,
      reason,
      executorReady: ready && (kind !== 'codex-cli' || bridge),
    }
    if (ready) {
      for (const model of kind === 'codex-cli' ? ['codex'] : (provider.models ?? []))
        candidates.push({
          key: `${provider.id}:${model}`,
          executor: connections[provider.id].executorReady,
        })
    }
  }
  const matrix = { 'codex-cli': false, openai: false }
  for (const provider of cfg.providers ?? [])
    if (connections[provider.id]?.ready) matrix[provider.kind ?? 'openai'] = true
  const pair = candidates.some((first) =>
    candidates.some((second) => second.key !== first.key && second.executor),
  )
  const { enabled, ...limits } = collab.normalize(cfg.collab)
  const blockers = [
    ...(enabled ? [] : ['双模型协作没有开启']),
    ...(pair ? [] : ['还缺少两个能分别承担指导和执行的可用模型']),
  ]
  let tests = { enabled: false, count: 0 }
  try {
    const stored = require('./project-tests.cjs').load()
    tests = { enabled: stored.enabled === true, count: stored.items?.length ?? 0 }
  } catch {
    /* Test configuration is optional. */
  }
  return {
    enabled,
    limits,
    roles: collab.ROLES,
    connections,
    matrix,
    ready: blockers.length === 0,
    blockers,
    codex: {
      ready: matrix['codex-cli'],
      note: matrix['codex-cli']
        ? '仅核对启动入口，实际登录与连接在运行时确认'
        : '未找到可用的 Codex CLI 连接',
    },
    projectTests: tests,
  }
}

module.exports = { status }
