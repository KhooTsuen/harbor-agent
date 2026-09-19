/**
 * 每次任务的执行预算（AG-040）
 *
 * 文档给的五项：
 *
 *   maxSteps 50 / maxToolCalls 100 / maxRuntime 1800 / maxRetries 3 / maxTokens 100000
 *
 * 达到预算后要给用户三件事：**继续 / 停止 / 调整预算**。
 *
 * ── 和「用量闸」（limits.cjs）什么关系 ──
 * 那个是**全局**的（今天 / 本月一共烧了多少 token，防的是「忘了关跑一晚上」）；
 * 这里是**单个任务**的（这次活最多跑多少轮、调多少次工具、跑多久）。
 * 两者互补：全局闸在调模型前查账，任务预算在**轮次边界**查账。
 *
 * ── 为什么也要有 maxRuntime ──
 * 轮数与工具次数管不住「一条命令卡在那儿半小时」。运行时长是唯一与「干了多少」
 * 无关的兜底。
 *
 * ── 超预算不是错误 ──
 * 它是**停下来等人**：任务标成 paused（可恢复），并记下是撞了哪一项 ——
 * 界面据此显示「已达到上限」和那三个按钮。别把它做成失败。
 */

const DEFAULTS = {
  /** 0 = 不限。轮数（每轮 = 一次模型调用） */
  maxSteps: 50,
  /** 0 = 不限。整个任务里的工具调用总数 */
  maxToolCalls: 100,
  /** 秒。0 = 不限 */
  maxRuntime: 1800,
  /** 单个工具失败后的自动重试次数上限（AG-016 的「必须有最大 Retry 次数」） */
  maxRetries: 3,
  /** 0 = 不限。这个任务累计的 token */
  maxTokens: 100000,
}

const LABELS = {
  maxSteps: '轮数上限',
  maxToolCalls: '工具调用上限',
  maxRuntime: '运行时长上限',
  maxTokens: '本任务 token 上限',
}

function num(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

/**
 * 这个任务用哪份预算：内置默认 ← 设置里的全局默认 ← 任务自己的覆盖。
 *
 * @param {object} [config] 主进程配置（读 `agent.budget`）
 * @param {object} [task] 任务台账里那条（读 `budget`）
 */
function resolve(config, task) {
  const fromConfig = config?.agent?.budget ?? config?.budget ?? {}
  const fromTask = task?.budget ?? {}
  const out = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (fromConfig[key] !== undefined) out[key] = num(fromConfig[key], DEFAULTS[key])
    if (fromTask[key] !== undefined) out[key] = num(fromTask[key], DEFAULTS[key])
  }
  return out
}

/**
 * 查一次账。
 *
 * @param {{ budget: object, startedAt: number, steps: number, toolCalls: number, tokens: number, now?: number }} input
 * @returns {{ exceeded: boolean, reason: string, label: string, used: number, limit: number,
 *             message: string, next: string }}
 */
function check({ budget, startedAt = 0, steps = 0, toolCalls = 0, tokens = 0, now = Date.now() }) {
  const hit = (reason, used, limit, next) => ({
    exceeded: true,
    reason,
    label: LABELS[reason] ?? reason,
    used,
    limit,
    next,
    message:
      `已达到本次任务的${LABELS[reason] ?? reason}（${format(used, reason)} / ${format(limit, reason)}）。` +
      `\n这是你设的任务预算，不是故障 —— 可以继续、停下，或者把上限调高。`,
  })

  const none = { exceeded: false, reason: '', label: '', used: 0, limit: 0, message: '', next: '' }

  if (budget.maxRuntime > 0 && startedAt > 0) {
    const seconds = Math.max(0, Math.round((now - startedAt) / 1000))
    if (seconds >= budget.maxRuntime) return hit('maxRuntime', seconds, budget.maxRuntime, '继续')
  }
  if (budget.maxSteps > 0 && steps >= budget.maxSteps) {
    return hit('maxSteps', steps, budget.maxSteps, '继续')
  }
  if (budget.maxToolCalls > 0 && toolCalls >= budget.maxToolCalls) {
    return hit('maxToolCalls', toolCalls, budget.maxToolCalls, '继续')
  }
  if (budget.maxTokens > 0 && tokens >= budget.maxTokens) {
    return hit('maxTokens', tokens, budget.maxTokens, '继续')
  }
  return none
}

/**
 * 轮次边界查一次账 —— 字段名由预算这边认，循环只要把计数递进来。
 * （放这里是为了让 `loop.cjs` 少几行：那边贴着 300 行上限。）
 */
function atTurnBoundary({ plan, startedAt, turn, toolRuns, usage }) {
  return check({
    budget: plan,
    startedAt,
    steps: turn,
    toolCalls: toolRuns?.length ?? 0,
    tokens: usage?.total ?? 0,
  })
}

/** 秒 / 轮 / 次 / token，单位不同，说人话 */
function format(value, reason) {
  const number = Number(value) || 0
  if (reason === 'maxRuntime') return `${Math.round(number / 60)} 分钟`
  if (reason === 'maxTokens') return `${number.toLocaleString()} token`
  return `${number}`
}

/**
 * 撞了预算 → 停下等人（**不是失败**）：状态标 paused，
 * 并记下撞的是哪一项、用了多少、上限多少 —— 界面要原样显示这几个数字。
 */
function pausePatch(verdict) {
  return {
    status: 'paused',
    pausedAt: Date.now(),
    pauseReason: 'budget',
    pauseDetail: verdict.reason ?? '',
    budgetHit: {
      reason: verdict.reason ?? '',
      label: verdict.label ?? '',
      used: verdict.used ?? 0,
      limit: verdict.limit ?? 0,
    },
  }
}

module.exports = { DEFAULTS, LABELS, resolve, check, atTurnBoundary, pausePatch, format }
