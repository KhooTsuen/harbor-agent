/**
 * 一次（或多次累计的）用量里总共有多少 token。
 *
 * ★ **上游给的是 OpenAI 原字段 `total_tokens`，不是 `total`。**
 *   最初这里（以及 loop-run 里）都写成 `usage.total` —— 真机上两个后果：
 *   控制台的 Token 一直显示「—」，`maxTokens` 预算**永远不触发**（永远是 0）。
 *   而单测全绿，因为测试桩自己编了 `{total: 123}` 这个不存在的形状。
 *   教训（AG-036 那次也栽过一遍）：**跨模块传结构时，形状本身要有一条断言**。
 *
 * @param {object} usage 可能是 `{prompt_tokens, completion_tokens, total_tokens}`
 * @returns {number}
 */
function usageTotal(usage) {
  if (!usage || typeof usage !== 'object') return 0
  /* 上游直接给的合计优先（两边命名都认，站点之间不一致） */
  const direct = Number(usage.total_tokens ?? usage.total)
  if (Number.isFinite(direct) && direct > 0) return direct
  /* 没给合计就自己加 */
  const parts =
    Number(usage.prompt_tokens ?? usage.prompt ?? 0) +
    Number(usage.completion_tokens ?? usage.completion ?? 0)
  return Number.isFinite(parts) && parts > 0 ? parts : 0
}

/**
 * 同一条 usage 拆成三个数：`{ total, input, output }`（AG-044）。
 *
 * 为什么要「入 / 出」：只记合计看不出贵在哪 —— 同样 1 万 token，
 * 「每轮重发整个上下文」（入多）和「模型话多」（出多）是两种毛病，
 * 修法完全不同（前者要压上下文 / 开缓存，后者要改提示词）。
 *
 * ★ 形状知识只留一份：字段名（`prompt_tokens` 也可能叫 `prompt`）在这里
 *   和 `usageTotal` 说**同一个**规则。分头写就会漂 —— AG-042 那次把
 *   `total_tokens` 读成 `total`，单测全绿、真机上用量永远是 0。
 *
 * @param {object} usage 可能是 `{prompt_tokens, completion_tokens, total_tokens}`
 * @returns {{ total: number, input: number, output: number }}
 */
function usageParts(usage) {
  if (!usage || typeof usage !== 'object') return { total: 0, input: 0, output: 0 }
  const input = Number(usage.prompt_tokens ?? usage.prompt) || 0
  const output = Number(usage.completion_tokens ?? usage.completion) || 0
  return { total: usageTotal(usage), input, output }
}

/**
 * 每次任务的执行预算（AG-040）
 *
 * ★ **五项默认全部不限（0）**（2026-09-29 用户要求：「关于这一类的全部都要默认不设限」）。
 *   这个模块是**刹车**，不是油门 —— 用户没要求时不该拦住他。原来默认「50 轮 / 100 次工具 /
 *   30 分钟 / 10 万 token」，结果是任务干到一半被标成「已暂停」，用户读到的却是
 *   「用量已经到上限」这类话，第一反应是「谁在拦我」。用户原话：
 *   「用量上限也是在没有勾选的时候有时候也是会被拦截用量上限」。
 *   要限的人自己在任务卡片「调整预算」里填 —— 那不是删功能，是换默认。
 *   兜底没丢：`loop.cjs` 还有一层 200 轮硬上限，`loop-guard` 还有转圈检测。
 *
 * 达到预算后要给用户三件事：**继续 / 停止 / 调整预算**（不是失败，是停下来等人）。
 *
 * ── 和「用量闸」（limits.cjs）什么关系 ──
 * 那个是**全局**的（今天 / 本月一共烧了多少 token，防的是「忘了关跑一晚上」）；
 * 这里是**单个任务**的。两者互补：全局闸在调模型前查账，任务预算在**轮次边界**查账。
 *
 * ── 为什么也要有 maxRuntime ──
 * 轮数与工具次数管不住「一条命令卡在那儿半小时」。运行时长是唯一与「干了多少」
 * 无关的兜底。
 */

const DEFAULTS = {
  /** 0 = 不限。轮数（每轮 = 一次模型调用） */
  maxSteps: 0,
  /** 0 = 不限。整个任务里的工具调用总数 */
  maxToolCalls: 0,
  /** 秒。0 = 不限 */
  maxRuntime: 0,
  /**
   * 单个工具失败后的自动重试次数上限（AG-016 的「必须有最大 Retry 次数」）。
   *
   * ★ 这一项**故意不是 0**：它不是「上限」而是「自动救一把的次数」。
   *   设成 0 等于关掉自动恢复；设成「不限」则一个坏掉的工具会被无限重试
   *   （`loop-tools.cjs` 是 `retry < maxRetries`，0 = 一次都不重试）。
   *   用户 2026-09-29 明确选了「保持 3 次」。
   */
  maxRetries: 3,
  /** 0 = 不限。这个任务累计的 token */
  maxTokens: 0,
  /** 软阈值（0~1）：用量到这比例就提醒模型「省着点」（token 优化），不影响硬上限 */
  softRatio: 0.8,
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
 * 老版本的内置默认值：盘上写着这些数字的，一律当成「用户没设过」→ 0（不限）。
 *
 * ★ **不迁移就等于没改。** `config-defaults.cjs` 只补「缺的键」，不会覆盖已存在的值，
 *   而老用户的 `config.json`（含本机那份）里这四项都已经被写死了 ——
 *   不改的话照样会在第 50 轮、10 万 token 上被拦下。
 *
 * 判据是「值正好等于老内置默认」：这四个字段在设置界面里**没有输入框**
 * （只能在任务卡片上按任务改），所以盘上出现 50/100/1800/100000 只可能是老默认。
 *
 * @returns {{ value: object, migrated: number }} `migrated` 只用于日志，便于排查
 */
const LEGACY_LIMITS = { maxSteps: 50, maxToolCalls: 100, maxRuntime: 1800, maxTokens: 100000 }

function legacyUnlimited(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const value = { ...source }
  let migrated = 0
  for (const [key, old] of Object.entries(LEGACY_LIMITS)) {
    if (Number(source[key]) === old) {
      value[key] = 0
      migrated += 1
    }
  }
  /*
   * 说一声。**静默改掉用户配置里的数字正是本项目最忌讳的事**，而且这条日志是排查
   * 「为什么以前会停、现在不停了」的唯一线索。惰性 require —— 只有真迁到东西时才加载日志
   * （也就启动那一次），省得给这个纯函数拉一条模块依赖。
   */
  if (migrated > 0) {
    require('./log.cjs').info(`任务预算的旧默认值已按「不限」处理（${migrated} 项）`)
  }
  return { value, migrated }
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
    if (key === 'softRatio') {
      const raw = fromTask[key] ?? fromConfig[key]
      const value = Number(raw)
      if (Number.isFinite(value)) out.softRatio = Math.min(1, Math.max(0, value))
      continue
    }
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
 * 重新生成的用量基线：旧任务已经消耗了多少 —— 新任务**从这里接着算**。
 *
 * 三项对应任务预算里的轮数 / 工具调用 / token：
 *   steps     ← 旧任务累计轮数（`turns`）
 *   toolCalls ← 旧任务台账里跑过的工具条数（`steps` 数组，一次调用一条）
 *   tokens    ← 旧任务累计 token
 *
 * ★ maxRuntime **不继承**：它是墙上时钟，跨任务累计没有意义（新 run 从 0 计），
 *   继承它会让「重新生成」一开局就撞时长上限。
 * ★ 旧任务三项都是 0（没消耗）→ 返回 null，调用方不用区分空对象。
 */
function carryOf(task) {
  if (!task) return null
  const steps = Number(task.turns) || 0
  const toolCalls = Array.isArray(task.steps) ? task.steps.length : 0
  const tokens = Number(task.tokens) || 0
  if (steps <= 0 && toolCalls <= 0 && tokens <= 0) return null
  return { steps, toolCalls, tokens }
}

/**
 * 轮次边界查一次账 —— 字段名由预算这边认，循环只要把计数递进来。
 * （放这里是为了让 `loop.cjs` 少几行：那边贴着 300 行上限。）
 *
 * `carry` = 重新生成时继承的基线（carryOf 的产物）：三项各加上再查 ——
 * 这样「旧任务烧到 80% → 重新生成」会从 80% 继续，而不重置为 0。
 */
function atTurnBoundary({ plan, startedAt, turn, toolRuns, usage, carry = null }) {
  const steps = turn + (Number(carry?.steps) || 0)
  const toolCalls = (toolRuns?.length ?? 0) + (Number(carry?.toolCalls) || 0)
  const tokens = usageTotal(usage) + (Number(carry?.tokens) || 0)
  const verdict = check({ budget: plan, startedAt, steps, toolCalls, tokens })
  /* 软阈值（不阻断）：到线了给模型一句「省着点」—— 只提醒，不砍安全检查 */
  if (!verdict.exceeded) {
    const ratio = Number(plan?.softRatio ?? DEFAULTS.softRatio)
    if (ratio > 0 && ratio < 1 && plan.maxTokens > 0 && tokens >= plan.maxTokens * ratio) {
      return {
        ...verdict,
        soft: true,
        softReason: 'maxTokens',
        softUsed: tokens,
        softLimit: plan.maxTokens,
      }
    }
  }
  return verdict
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

/** 软阈值提醒文案（token 优化 §6.6：优先完成可验证步骤，砍解释不砍验证） */
function softNote(verdict) {
  const pct = verdict?.softLimit > 0 ? Math.round((verdict.softUsed / verdict.softLimit) * 100) : 0
  return (
    `[预算提醒] 本次任务 token 已用到 ${pct}%（${Number(verdict?.softUsed || 0).toLocaleString()} / ${Number(verdict?.softLimit || 0).toLocaleString()}）。\n` +
    '接下来：优先完成当前可验证步骤，保留文件验证与安全检查；减少解释、避免重复读取无关文件；收尾时给结论与证据。'
  )
}

module.exports = {
  DEFAULTS,
  LABELS,
  LEGACY_LIMITS,
  resolve,
  check,
  atTurnBoundary,
  carryOf,
  pausePatch,
  format,
  softNote,
  usageTotal,
  usageParts,
  legacyUnlimited,
}
