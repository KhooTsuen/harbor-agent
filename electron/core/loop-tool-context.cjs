const log = require('./log.cjs')
const skillPin = require('./skill-pin.cjs')
const userConstraints = require('./user-constraints.cjs')

function buildToolContext({
  options,
  config,
  workdir,
  mode,
  threadSettings,
  userText,
  useProvider,
  useModel,
  signal,
  confirm,
  emit,
}) {
  return {
    workdir,
    vision: { config, provider: useProvider, model: useModel },
    sessionId: options.sessionId ?? '',
    taskId: options.taskId ?? '',
    changeSetId: options.changeSetId ?? '',
    permission: config.tools.permission,
    allowTools: threadSettings.allowTools !== false,
    allowWrite: userConstraints.allowsWrite({
      userText,
      mode,
      threadAllowWrite: threadSettings.allowWrite,
    }),
    allowNetwork: userConstraints.allowsNetwork({
      userText,
      threadAllowNetwork: threadSettings.allowNetwork,
    }),
    temporary: options.temporary === true,
    shellTimeout: config.tools.shellTimeout,
    shellPolicy: config.tools.shellPolicy,
    fileScope: config.tools.fileScope,
    outputLimit: config.tools.outputLimit,
    signal,
    confirm,
    log,
    ...skillPin.ctxGrant(threadSettings),
    emit,
    granted: new Map(),
  }
}

module.exports = { buildToolContext }
