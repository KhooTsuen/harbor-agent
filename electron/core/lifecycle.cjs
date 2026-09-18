/**
 * Agent 生命周期状态机（唯一真相源）
 *
 * 需求文档 AG-001：
 *   · 每个任务有唯一 taskId
 *   · 所有状态由 Execution Engine 驱动
 *   · **Renderer 不得自行推断后台状态**
 *   · 每次状态变化产生事件
 *   · 必须区分 cancelled / failed / completed
 *
 * 改造前的问题：前端 `turns.ts` 自己 `setThreadStatus(threadId, 'running')` ——
 * UI 说在跑就是在跑，后台真停了 UI 也不知道；而且 `ThreadStatus`
 * （running/success/error/waiting）和 `AgentPhase`（idle/thinking/…）是两套并行状态，
 * 各模块各读各的。现在只有这一个来源。
 *
 * 状态集按文档 §2 定，13 个：
 *   idle preparing thinking planning executing verifying responding completed
 *   waiting_user paused retrying cancelled failed
 *
 * 「reading / writing / searching」这类**工具级细分不进状态机** —— 它们属于
 * `executing` 期间的**动作描述**（AG-008 要的那句「正在读取相关文件…」），
 * 用事件里的 detail 字段表达。状态机只关心「阶段」，不关心「在干什么活」。
 */

/** 状态集（顺序就是生命周期顺序，旁路状态在后） */
const PHASES = [
  'idle',
  'preparing',
  'thinking',
  'planning',
  'executing',
  'verifying',
  'responding',
  'completed',
  'waiting_user',
  'paused',
  'retrying',
  'cancelled',
  'failed',
]

/**
 * 合法转移表。
 *
 * 没列出来的转移一律拒绝 —— 与其让状态悄悄跑偏（那种 bug 只有用户能发现），
 * 不如在转移时就抛出来。`executing → executing` 是有意的：一轮任务里会执行
 * 很多次工具，每次都算一次「仍在执行」，但每次都要产生事件（AG-002）。
 */
const TRANSITIONS = {
  idle: ['preparing', 'cancelled'],
  preparing: ['thinking', 'executing', 'failed', 'cancelled'],
  thinking: [
    'planning',
    'executing',
    'responding',
    'waiting_user',
    'retrying',
    'failed',
    'cancelled',
  ],
  planning: ['executing', 'responding', 'waiting_user', 'failed', 'cancelled'],
  executing: [
    'executing',
    'thinking',
    'verifying',
    'responding',
    'waiting_user',
    'retrying',
    'paused',
    'failed',
    'cancelled',
  ],
  verifying: ['responding', 'executing', 'retrying', 'failed', 'cancelled'],
  responding: ['completed', 'executing', 'failed', 'cancelled'],
  waiting_user: ['executing', 'thinking', 'planning', 'paused', 'cancelled'],
  paused: ['executing', 'thinking', 'planning', 'cancelled'],
  retrying: ['thinking', 'executing', 'failed', 'cancelled'],
  /* 终态：出不去 */
  completed: [],
  failed: [],
  cancelled: [],
}

/** 终态。到了这里任务就结束了，不再有后续状态 */
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

/** 还「没干完」的状态 —— 重启后提示续做、侧栏黄点都用它 */
const UNFINISHED = new Set([
  'preparing',
  'thinking',
  'planning',
  'executing',
  'verifying',
  'responding',
  'waiting_user',
  'paused',
  'retrying',
])

function isPhase(value) {
  return PHASES.includes(String(value))
}

function isTerminal(phase) {
  return TERMINAL.has(String(phase))
}

function canTransition(from, to) {
  const allowed = TRANSITIONS[String(from)]
  return Array.isArray(allowed) && allowed.includes(String(to))
}

/**
 * 每个 taskId 一个状态机。
 *
 * `listener` 在每次**真的发生转移**时被调用（同状态重复设置不算），
 * 拿到 `{ taskId, from, to, at, detail }` —— 调用方据此产生 AG-002 的标准事件。
 */
function createMachine({ taskId = '', initial = 'idle' } = {}) {
  if (!isPhase(initial)) throw new Error(`未知的初始状态：${initial}`)

  let current = initial
  const history = [{ phase: initial, at: Date.now(), detail: '' }]

  function to(next, detail = '') {
    const target = String(next)
    if (!isPhase(target)) throw new Error(`未知状态：${target}`)
    if (target === current) return { ok: true, skipped: true, phase: current }

    if (!canTransition(current, target)) {
      /* 终态之后再收到转移是正常的（比如 cancelled 后又来一个 failed）—— 忽略并记一笔 */
      const reason = isTerminal(current)
        ? `已经是终态 ${current}`
        : `${current} → ${target} 不是合法转移`
      return { ok: false, phase: current, error: reason }
    }

    const from = current
    current = target
    const event = { taskId, from, to: target, at: Date.now(), detail: String(detail ?? '') }
    history.push({ phase: target, at: event.at, detail: event.detail })
    for (const fn of listeners) {
      try {
        fn(event)
      } catch {
        /* 订阅者出错不能影响状态机本身 */
      }
    }
    return { ok: true, from, phase: target }
  }

  return {
    get phase() {
      return current
    },
    get history() {
      return history.slice()
    },
    get terminal() {
      return isTerminal(current)
    },
    to,
  }
}

/** 状态转移的订阅者。主进程注册**一个**转发器，把转移变成 AG-002 的标准事件 */
const listeners = new Set()

/** 订阅状态转移，返回退订函数 */
function onTransition(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 进程内的状态机注册表：taskId → machine */
const machines = new Map()

/** 拿（或建）某个任务的状态机 */
function forTask(taskId, options = {}) {
  const key = String(taskId || 'anonymous')
  let machine = machines.get(key)
  if (!machine) {
    machine = createMachine({ taskId: key, initial: options.initial ?? 'idle' })
    machines.set(key, machine)
  }
  return machine
}

/**
 * 便捷入口：给某个任务打一个阶段。
 *
 * Loop 里要打十几处，每次都 `forTask(id).to(phase)` 太啰嗦 —— 而且那个
 * `forTask(...)` 的返回值如果被存成变量，任务换了就会用错状态机。
 */
function mark(phase, taskId = '', detail = '') {
  return forTask(taskId).to(phase, detail)
}

/** 换一个任务的初始状态（任务还没建时先置成 preparing 之类） */
function reset(taskId, phase = 'idle') {
  const key = String(taskId || 'anonymous')
  const machine = createMachine({ taskId: key, initial: phase })
  machines.set(key, machine)
  return machine
}

/** 忘掉一个任务（结束时清，免得 Map 无限涨） */
function forget(taskId) {
  machines.delete(String(taskId || 'anonymous'))
}

function clearAll() {
  machines.clear()
}

module.exports = {
  PHASES,
  TRANSITIONS,
  TERMINAL,
  UNFINISHED,
  isPhase,
  isTerminal,
  canTransition,
  createMachine,
  forTask,
  mark,
  reset,
  onTransition,
  forget,
  clearAll,
}
