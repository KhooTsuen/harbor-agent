const log = require('./log.cjs')
const skillPin = require('./skill-pin.cjs')
const userConstraints = require('./user-constraints.cjs')
const userGrants = require('./user-grants.cjs')

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
  // Delegated plans and tool output carry data; only original human text grants authority.
  const authorizationText =
    typeof options.authorizationText === 'string' ? options.authorizationText : userText
  /*
   * 记下「这个会话他说过授权」—— 判据在 user-constraints（唯一真相源），
   * 这里只负责把这一轮的原话送进去判一次。授权轮之后用户改口说「继续」，
   * C 闸仍认这是同一件事，不会重新问（见 user-grants.cjs 的文件头）。
   */
  if (options.collabSubStep !== true) userGrants.noteGrant(options.sessionId ?? '', {
    granted: userConstraints.grantsWriteIn(authorizationText),
    stopped: userConstraints.noWriteIn(authorizationText),
  })
  return {
    workdir,
    vision: { config, provider: useProvider, model: useModel },
    sessionId: options.sessionId ?? '',
    recallEvidence: options.recallEvidence,
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
      userText: authorizationText,
      mode,
      threadAllowWrite: threadSettings.allowWrite,
    }),
    /* 这一轮用户原话：写工具那两道闸要靠它判断「已经明确授权了别再问」 */
    lastUserText: typeof authorizationText === 'string' ? authorizationText : '',
    allowNetwork: userConstraints.allowsNetwork({
      userText: authorizationText,
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
