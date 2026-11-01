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
/* P0-3：归属判定只有一处（见下面 runTurn 里的注释） */
const taskAttribution = require('../core/task-attribution.cjs')
/* P0-1（第六轮）：原话有损时的**程序级**闸门（判定只有一处，见那边文件头） */
const foldGate = require('../core/fold-gate.cjs')
/* 确认入口复用「澄清卡」那条往返（不开新 IPC 通道）；问题形状交给 clarify.normalize 校验 */
const clarify = require('../core/clarify.cjs')
const chatConfirm = require('./chat-confirm.cjs')

/**
 * 有损时**问用户**：要不要按现有信息继续（P0-1 第六轮）。
 *
 * 为什么要走卡片而不是「看下一条消息写了什么」：提示过不等于用户同意过 ——
 * 拿关键词猜「他是不是说继续 / 是不是补全了」正是这一轮要消灭的错。
 * 卡片上的选择是一个**明确动作**，且两个出口的后果都写在卡上。
 *
 * @returns {Promise<boolean>} 只有点了「按现有信息继续」才为 true
 */
async function askContinue({ still, sessionId, phaseKey, emit }) {
  if (typeof emit !== 'function') return false
  const questions = clarify.normalize(foldGate.askSpec(still)).questions
  if (questions.length === 0) return false
  const reply = await chatConfirm.askClarify({ sessionId, taskId: phaseKey, questions, emit })
  if (reply.skipped === true) return false
  const picked = Array.isArray(reply.answers) ? reply.answers[0] : null
  return String(picked?.choice ?? '') === foldGate.CHOICE_CONTINUE
}


/**
 * @param {object} args
 */
async function runTurn(args) {
  const {
    payload,
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
    /* 这次发送的历史里，用户原话有没有被折叠截掉（`chat-parts.windowHistory` 给的） */
    foldLossy = [],
  } = args
  /*
   * ★ P0-1：**有损就停手**，一个 Provider 请求都不发 —— 而且「停手」要问到用户本人。
   *
   * 上一版在这里只是「提示过一次就放行」，等于拿用户没说过的话去记他（见
   * `core/fold-gate.cjs` 文件头）。现在：
   *   · 没获确认 / 没补充到位 → 弹确认卡问「按现有信息继续」还是「我先补充」；
   *   · 点了继续 → 记下**这一段指纹**（只对当前对话生效）→ 这一轮放行；
   *   · 没点 / 关掉 / 超时 → 抛错，`chat:send` 的 catch 把原委写进当前对话。
   * `supplied` 传的是**要发出去的那一份**文本（可能已落文件），所以「补了但没发出去」
   * 不会被当成补齐。
   */
  const gate = foldGate.inspect({
    sessionId,
    lossy: foldLossy,
    rawHistory,
    supplied: lastUserText(args.history),
    /* 这次真要发出去的那份历史 —— 判定「刚提示过的原话整轮被省略」（见 fold-gate.vanished） */
    delivered: args.history,
  })
  /** @type {'supplied' | 'confirmed'} 放行靠的是哪条路径（措辞不同，见 fold-gate.acknowledge） */
  let ackMode = gate.supplied.length > 0 ? 'supplied' : 'confirmed'
  if (gate.blocked) {
    const go = await askContinue({ still: gate.pending, sessionId, phaseKey, emit })
    foldGate.markNotified({ sessionId, lossy: foldLossy })
    if (!go) throw new Error(gate.message)
    foldGate.confirm({ sessionId, lossy: gate.pending })
    ackMode = 'confirmed'
  }
  /* 放行时把折叠块里「先请用户确认」换成**如实**的说明（只改发给模型那份） */
  const history = foldGate.acknowledge(args.history, ackMode)

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
      origin: payload?.origin === 'edge-sidepanel' ? 'edge-sidepanel' : '',
      allowBuiltinBrowser: false,
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

  /*
   * ★ P0-3（2026-10-23）：归属判定**就在这里做一次**，结果同时喂给提示与台账。
   *
   * 以前提示用的是 `payload.taskId`（渲染层认不认得出「继续」跟它无关），而台账是
   * 之后在 `loop-run` 里另判一次「复用还是新建」—— 于是提示可能指向 A、
   * 台账却新建了 B。现在只判一次，`loop.run` 拿到的是同一份结论。
   */
  const decided = taskAttribution.decide({
    resumeTaskId: typeof payload?.resumeTaskId === 'string' ? payload.resumeTaskId : '',
    sessionId,
    goal: lastUserText(history),
  })

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
    /* 同一份归属结论 —— loop-run 不再自己判一遍 */
    attribution: decided,
    regenerateOf: typeof payload?.regenerateOf === 'string' ? payload.regenerateOf : '',
    regenerateLast: payload?.regenerateIsLast === true,
    emit,
    confirm,
    sessionId,
    projectId: typeof payload?.projectId === 'string' ? payload.projectId : '',
    origin: payload?.origin === 'edge-sidepanel' ? 'edge-sidepanel' : '',
    allowBuiltinBrowser: false,
    traceId: phaseKey,
    taskState: require('../core/task-context.cjs').buildTaskState({
      sessionId,
      taskId: typeof payload?.taskId === 'string' ? payload.taskId : '',
      userText: lastUserText(history),
      workdir,
      projectId: typeof payload?.projectId === 'string' ? payload.projectId : '',
      /* 提示里「哪条是当前任务」只听这份结论（P0-3） */
      attribution: decided,
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
