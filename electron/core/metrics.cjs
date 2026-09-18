/**
 * 任务时间线埋点（AG-003）
 *
 * 文档要的六个时刻：
 *
 *   requestTime        用户按下发送（渲染层带过来的）
 *   taskCreatedTime    主进程建好任务
 *   firstFeedbackTime  第一条事件发出去（「正在准备任务…」就是这一刻）
 *   firstTokenTime     模型吐出第一个字（正文或思考都算）
 *   firstToolTime      第一次工具开始
 *   completionTime     结束（完成 / 失败 / 取消）
 *
 * 三个指标：
 *
 *   TTFT                 firstToken - requestTime
 *   First Tool Feedback  firstTool  - requestTime
 *   Total Task Duration  completion - requestTime
 *
 * **为什么要记**：AG-003 的目标是「用户发送后必须**立即**获得反馈」。
 * 没有数字就只能靠感觉 —— 「有点慢」到底是 IPC 慢、建任务慢、还是模型慢？
 * 六个时刻分开看，一眼能指出卡在哪一段。
 *
 * 设计上刻意不做的事：
 *
 * · **不测「用户看到」**。主进程测不到渲染完成，硬测就是自欺。这里记的是
 *   「主进程这侧的延迟」；「按下发送到本地显示」那一段在前端是同步的（≈0ms），
 *   不需要埋点来证明。
 * · **不留历史**。指标算完就发事件、然后从内存里删掉 —— 要长期统计就读
 *   `data/events/*.jsonl` 里的 `metrics.timeline`，不在这里囤。
 */

const bus = require('./events.cjs')

/** traceId → 六个时刻。只留最近这些，防内存无限涨 */
const MAX_PENDING = 50
const pending = new Map()

/**
 * 开始记一条任务的时间线。
 *
 * @param {string} traceId 事件流的 key（和 chat.cjs 的 phaseKey 是同一个）
 * @param {{requestTime?: number, at?: number}} [opts]
 *   `requestTime` 由渲染层带过来（用户真正按下发送的时刻）；不传就用现在
 */
function begin(traceId, opts = {}) {
  const key = String(traceId || '')
  if (!key) return null

  const now = typeof opts.at === 'number' ? opts.at : Date.now()
  const timeline = {
    traceId: key,
    requestTime:
      typeof opts.requestTime === 'number' && opts.requestTime > 0 ? opts.requestTime : now,
    taskCreated: 0,
    firstFeedback: 0,
    firstToken: 0,
    firstTool: 0,
    completion: 0,
  }

  pending.set(key, timeline)
  /* 超过上限删最老的（Map 保持插入顺序） */
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next().value
    pending.delete(oldest)
  }
  return timeline
}

/**
 * 拿一个事件去认领时刻。
 *
 * 在 `chat.cjs` 的 emit 包装里调一次就够了 —— 它能看到这一轮所有事件，
 * 不用在每个模块里各插一遍埋点。
 */
function observe(traceId, event, at) {
  const timeline = pending.get(String(traceId || ''))
  if (!timeline) return
  const type = String(event?.type ?? '')
  const now = typeof at === 'number' ? at : Date.now()

  /* 第一条事件 = 首次反馈（不管是什么事件，发出去用户就能看见了） */
  if (!timeline.firstFeedback) timeline.firstFeedback = now

  switch (type) {
    case 'task':
      if (!timeline.taskCreated) timeline.taskCreated = now
      break
    case 'content':
    case 'reasoning':
      /* 正文和思考都算「模型开始吐字」—— 纯推理模型可能先出思考 */
      if (!timeline.firstToken) timeline.firstToken = now
      break
    case 'agent.tool.started':
    case 'agent.tool.failed':
      if (!timeline.firstTool) timeline.firstTool = now
      break
    case 'agent.completed':
    case 'agent.failed':
    case 'agent.cancelled':
      if (!timeline.completion) timeline.completion = now
      break
    default:
      break
  }
}

function delta(from, to) {
  return from > 0 && to >= from ? to - from : null
}

/** 这一轮跑完了 —— 算指标、发事件、清内存 */
function finish(traceId, opts = {}) {
  const key = String(traceId || '')
  const timeline = pending.get(key)
  if (!timeline) return null

  const now = typeof opts.at === 'number' ? opts.at : Date.now()
  /* 异常退出时 completion 可能没记到 —— 用现在兜底，别丢整条数据 */
  if (!timeline.completion) timeline.completion = now

  const report = {
    ...timeline,
    /* 首反馈延迟：按下发送 → 第一条事件出去（这段时间用户面对的是「没反应」） */
    firstFeedbackMs: delta(timeline.requestTime, timeline.firstFeedback),
    taskCreatedMs: delta(timeline.requestTime, timeline.taskCreated),
    ttftMs: delta(timeline.requestTime, timeline.firstToken),
    firstToolMs: delta(timeline.requestTime, timeline.firstTool),
    totalMs: delta(timeline.requestTime, timeline.completion),
  }

  pending.delete(key)

  /*
   * 显式 persist —— 让 metrics.timeline 也进 data/events/*.jsonl。
   * 总线默认只落 agent.*，但时间线同样是「事后要能查」的东西。
   */
  bus.emit('metrics.timeline', report, { taskId: key, persist: true })

  return report
}

/** 拿到某条任务的时间线（还没 finish 时也能读，诊断用） */
function get(traceId) {
  return pending.get(String(traceId || '')) ?? null
}

function clear() {
  pending.clear()
}

module.exports = { begin, observe, finish, get, clear, MAX_PENDING }
