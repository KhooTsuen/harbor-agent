/**
 * 对话 IPC 的「跑一轮」：单模型走 loop，多模型走协作编排（2026-10-17）
 *
 * 从 `handlers/chat.cjs` 抽出来 —— 那边贴着 300 行红线。这里把
 * 「有 collab 选择 → runCollaboration；没有 → loop.run」两条路收成一个
 * 统一返回形状（都带 content / reasoning / usage / turns / toolRuns），
 * 让 chat.cjs 的 done 事件与收尾逻辑不用分两条。
 *
 * ★ 权限边界全在各自内核里：loop 四道闸、协作的项目根授权 + 逐次审批 +
 *   审计 + 取消，这里只做「分流」，不重写任何一道闸（硬约束 9）。
 */

const loop = require('../core/loop.cjs')
const collab = require('../core/collab.cjs')

/**
 * @param {object} args
 */
async function runTurn(args) {
  const {
    payload,
    history,
    rawHistory,
    effective,
    workdir,
    mode,
    controller,
    pause,
    emit,
    confirm,
    sessionId,
    phaseKey,
  } = args

  /* 多模型协作：payload 带 collab（A/B 选择）→ 走协作编排 */
  if (payload?.collab && typeof payload.collab === 'object') {
    const goal = lastUserText(history) || (lastUserImages(history).length ? '用户只附加了图片。请先读取并描述图片内容，再询问用户希望基于图片完成什么。' : '')
    const imageUrls = lastUserImages(history)
    const res = await collab.runCollaboration({
      goal,
      selected: true,
      images: imageUrls,
      projectRoot: workdir,
      config: effective,
      sessionId,
      phaseKey,
      signal: controller.signal,
      confirm,
      emit,
      planner: payload.collab.planner,
      executor: payload.collab.executor,
      threadSettings: payload?.threadSettings ?? {},
    })
    /* 转成 loop.run 同形状：content = 汇报正文；toolRuns 从 trace 映射 */
    return {
      content: res.ok === true ? res.report : res.message,
      reasoning: '',
      usage: null,
      turns: 'phases' in res && Array.isArray(res.phases) ? res.phases.length : 0,
      toolRuns: ('trace' in res ? res.trace.tools : []).map((t) => ({
        id: '',
        name: t?.name ?? '',
        ok: t?.ok === true,
        args: {},
        output: '',
      })),
      exhausted: false,
      _collab: res,
    }
  }

  /* 单模型：原样走 loop */
  return loop.run({
    history,
    fullHistory: rawHistory,
    config: effective,
    workdir,
    mode,
    signal: controller.signal,
    controls: { pauseRequested: () => pause.requested },
    resumeTaskId: typeof payload?.resumeTaskId === 'string' ? payload.resumeTaskId : '',
    regenerateOf: typeof payload?.regenerateOf === 'string' ? payload.regenerateOf : '',
    regenerateLast: payload?.regenerateIsLast === true,
    emit,
    confirm,
    sessionId,
    projectId: typeof payload?.projectId === 'string' ? payload.projectId : '',
    traceId: phaseKey,
    taskState: require('../core/task-context.cjs').buildTaskState({
      sessionId,
      taskId: typeof payload?.taskId === 'string' ? payload.taskId : '',
      userText: lastUserText(history),
      workdir,
      projectId: typeof payload?.projectId === 'string' ? payload.projectId : '',
    }),
    goal: lastUserText(history),
    temporary: payload?.temporary === true,
    threadSettings: payload?.threadSettings ?? {},
  })
}

/** 历史里最后一条用户消息的原文（与 loop-route.lastUserText 同口径，这里只读一份） */
function lastUserText(history) {
  const lastUser = [...(history ?? [])].reverse().find((m) => m.role === 'user')
  if (typeof lastUser?.content === 'string') return lastUser.content
  return Array.isArray(lastUser?.content)
    ? lastUser.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
    : ''
}

function lastUserImages(history) {
  const lastUser = [...(history ?? [])].reverse().find((m) => m.role === 'user')
  return Array.isArray(lastUser?.content)
    ? lastUser.content.filter((part) => part?.type === 'image_url').map((part) => part.image_url?.url).filter(Boolean)
    : []
}

module.exports = { runTurn, lastUserText, lastUserImages }
