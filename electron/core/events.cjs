/**
 * 统一 Agent Event Bus（AG-002）
 *
 * 改造前：事件由各模块自己 `send('chat:event', {...})`，名字各起各的
 * （`tool_start` / `tool_end` / `review` / `phase`…），结构也各不相同。
 * 想回答「这一轮到底发生过什么」，得挨个模块去翻。
 *
 * 现在：
 *
 * ① **一个出口** —— 所有 Agent 事件都过 `emit()`，统一结构
 *    `{ eventId, taskId, timestamp, type, payload }`（文档 AG-002 给的结构）
 * ② **一套名字** —— 生命周期事件用文档那 16 个 `agent.*` 标准名。
 *    状态机怎么转移，事件就怎么发（`eventForTransition`），不是各写各的
 * ③ **一份存档** —— 环形缓冲（进程内的 UI / 日志 / Task Center 共享同一份）
 *    ＋ `data/events/*.jsonl` 落盘（诊断包读得到）
 *
 * 两个刻意的取舍：
 *
 * · **流式增量不落盘**。一条长回答能有几万个 content 增量，全写盘会把磁盘
 *   写爆，而且它们只是传输细节，没有审计价值 —— 落盘的只有 `agent.*`。
 * · **事件不能影响主流程**。落盘失败、订阅者抛错，聊天该继续继续，
 *   只往主日志丢一条 warn。事件系统是旁路，不是主路。
 *
 * 这不是第二套状态 —— 状态仍然只有 `lifecycle.cjs` 那一份。
 * 总线只是把它广播出来，让所有观察者看同一个来源。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const { scrub } = require('./redact.cjs')
const log = require('./log.cjs')

/** 文档 AG-002 列的标准事件名。生命周期事件只用这些。 */
const AGENT_EVENTS = [
  'agent.started',
  'agent.thinking',
  'agent.planning',
  'agent.tool.started',
  'agent.tool.progress',
  'agent.tool.completed',
  'agent.tool.failed',
  'agent.verification.started',
  'agent.verification.completed',
  'agent.waiting_user',
  'agent.retrying',
  'agent.paused',
  'agent.resumed',
  'agent.cancelled',
  'agent.completed',
  'agent.failed',
]

/**
 * 状态机相位 → 标准事件名。
 *
 * 没列出来的（idle / executing / responding）**有意不发**：
 * · `idle` 是「什么也没发生」
 * · `executing` 期间具体的 `agent.tool.*` 更细，再来一条粗的只是噪音
 * · `responding` 期间正文增量（content）本身就是信号
 */
const PHASE_TO_EVENT = {
  preparing: 'agent.started',
  thinking: 'agent.thinking',
  planning: 'agent.planning',
  verifying: 'agent.verification.started',
  waiting_user: 'agent.waiting_user',
  paused: 'agent.paused',
  retrying: 'agent.retrying',
  completed: 'agent.completed',
  failed: 'agent.failed',
  cancelled: 'agent.cancelled',
}

/** 环形缓冲：进程内所有观察者共享的最近事件（UI / 日志 / Task Center） */
const RING_SIZE = 300
const ring = []
const listeners = new Set()
let seq = 0

function nextId(ts) {
  seq += 1
  return `evt_${ts.toString(36)}_${seq.toString(36)}`
}

function eventsDir() {
  return path.join(DIRS.data, 'events')
}

function dayFile(ts) {
  return path.join(eventsDir(), `${new Date(ts).toISOString().slice(0, 10)}.jsonl`)
}

/**
 * 发一个事件。
 *
 * @param {string} type    事件名（生命周期请用 AGENT_EVENTS 里的）
 * @param {object} payload 载荷
 * @param {{taskId?: string, persist?: boolean, at?: number}} [opts]
 *   `persist` 默认按「是不是 agent.*」决定，可以强制
 * @returns {object} 完整事件（含 eventId）
 */
function emit(type, payload = {}, opts = {}) {
  const name = typeof type === 'string' && type ? type : 'unknown'
  const ts = typeof opts.at === 'number' ? opts.at : Date.now()
  const event = {
    eventId: nextId(ts),
    taskId: typeof opts.taskId === 'string' ? opts.taskId : '',
    timestamp: ts,
    type: name,
    payload: payload && typeof payload === 'object' ? payload : {},
  }

  ring.push(event)
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE)

  const persist = opts.persist ?? name.startsWith('agent.')
  if (persist) append(event)

  for (const fn of listeners) {
    try {
      fn(event)
    } catch (error) {
      log.warn(`事件订阅者抛错：${error instanceof Error ? error.message : error}`)
    }
  }

  return event
}

/** 落盘。只写生命周期事件，且参数里的密钥要过脱敏。 */
function append(event) {
  try {
    fs.mkdirSync(eventsDir(), { recursive: true })
    const line = JSON.stringify({
      ...event,
      payload: scrub(event.payload) ?? {},
    })
    fs.appendFileSync(dayFile(event.timestamp), `${line}\n`, 'utf8')
  } catch (error) {
    /* 事件系统是旁路 —— 盘满了也不能让聊天失败 */
    log.warn(`事件落盘失败：${error instanceof Error ? error.message : error}`)
  }
}

/** 订阅所有事件，返回取消订阅的函数 */
function on(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * 取最近的事件。
 * @param {number} n 最多几条
 * @param {(e: object) => boolean} [filter]
 */
function recent(n = 50, filter) {
  const list = typeof filter === 'function' ? ring.filter(filter) : ring.slice()
  return list.slice(-Math.max(0, n))
}

/**
 * 状态机转移 → 标准事件名。
 *
 * 大部分转移看**目标相位**就够（`thinking` → `agent.thinking`）。
 * 只有两条要看**从哪来**：
 *   · 离开 `verifying` 且进入 `responding` = 验证通过
 *   · 从 `paused` 出去 = 恢复
 *
 * @returns {string|null} 没有对应标准事件时返回 null（比如 executing 内部循环）
 */
function eventForTransition(from, to) {
  if (from === 'verifying' && to === 'responding') return 'agent.verification.completed'
  if (from === 'paused' && to !== 'paused') return 'agent.resumed'
  return PHASE_TO_EVENT[to] ?? null
}

function clear() {
  ring.length = 0
}

/** 仅供测试：重置计数，免得断言 id 时受别的用例影响 */
function resetSeq() {
  seq = 0
}

module.exports = {
  AGENT_EVENTS,
  PHASE_TO_EVENT,
  RING_SIZE,
  emit,
  on,
  recent,
  clear,
  resetSeq,
  eventForTransition,
  eventsDir,
}
