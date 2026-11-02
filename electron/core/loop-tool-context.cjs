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
    /*
     * 项目身份：**唯一真相源是 `options.projectId`** —— 和提示词里注入记忆用的
     * 是同一个字段（`loop-prompt.cjs` 也读 `options.projectId`），所以「写进哪」和
     * 「从哪读」不会各说各话（AGENT.md 硬约束 9）。
     *
     * ★ 以前这里没有这一项：`remember` 拿不到项目 ID → `scope='project'` 的记忆
     *   落成 `projectId: ''` → `memory-scope.visible()` 对空串 fail-closed
     *   → 既不会注入、也搜不到，等于写进黑洞（2026-11-02 生产库 11 条全这样）。
     *
     * `?? ''` 是**故意**的 fail-closed：没有项目上下文时，项目级记忆既不该写、
     * 也不该看得见；不要在这里按 workdir / 会话去猜一个项目 ID。
     */
    projectId: options.projectId ?? '',
    origin: options.origin === 'edge-sidepanel' ? 'edge-sidepanel' : '',
    allowBuiltinBrowser: options.allowBuiltinBrowser === true,
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
