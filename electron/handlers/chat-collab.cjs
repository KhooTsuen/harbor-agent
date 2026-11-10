const { runCollaboration } = require('../core/collab.cjs')
const { lastUserText } = require('../core/loop-route.cjs')
const chatConfirm = require('./chat-confirm.cjs')

async function run(args, history, images) {
  const { payload, effective, workdir, sessionId, phaseKey, controller, confirm } = args
  /* 编排可能由自检直接调用（不带 UI 事件出口 / 暂停标记）；缺省成空壳，不能因此崩在收尾或轮询那行 */
  const emit = typeof args.emit === 'function' ? args.emit : () => {}
  const pause = args.pause && typeof args.pause === 'object' ? args.pause : { requested: false }
  const result = await runCollaboration({
    goal: lastUserText(history) || (images.length ? '请先读取图片，再询问用户需要完成什么' : ''),
    images,
    selected: true,
    projectRoot: workdir,
    config: effective,
    context: require('../core/collab-context.cjs').historyContext(history),
    sessionId,
    phaseKey,
    projectId: payload.projectId,
    resumeTaskId: payload.resumeTaskId,
    origin: payload.origin === 'edge-sidepanel' ? 'edge-sidepanel' : '',
    allowBuiltinBrowser: false,
    signal: controller.signal,
    controls: { pauseRequested: () => pause.requested },
    confirm,
    closePending: () => {
      if (emit.requestId) chatConfirm.closeOut(emit.requestId)
    },
    emit,
    planner: payload.collab.planner,
    executor: payload.collab.executor,
    threadSettings: payload.threadSettings ?? {},
  })
  if (!result.collaboration) emit({ type: 'phase', phase: 'failed' })
  const content = String(result.finalContent || result.message || '协作未返回可用结果')
  const status = result.collaboration?.status
  return {
    content,
    finalContent: content,
    reasoning: '',
    usage: result.usage ?? null,
    turns: result.phases?.length ?? 0,
    toolRuns: result.toolRuns ?? [],
    taskId: result.taskId,
    paused: status === 'paused',
    exhausted: [
      'COLLAB_ROUND_LIMIT', 'COLLAB_TIME_LIMIT', 'COLLAB_TOKEN_LIMIT', 'EXEC_EXHAUSTED',
    ].includes(result.code),
    finishReason: result.accepted ? 'stop' : '',
    verdict: result.accepted ? 'done' : result.collaboration ? 'partial' : 'failed',
    collaboration: result.collaboration,
    _collab: result,
  }
}

module.exports = { run }
