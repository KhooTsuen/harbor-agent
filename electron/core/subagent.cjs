/**
 * 子代理（v0：**只读侦察兵**）
 *
 * ── 它是什么 ──
 * 父任务派一个子代理去读一批文件 / 查资料，只把**整理好的结论**带回来 ——
 * 子代理读过的文件内容**不进父任务的上下文**。这是「上下文隔离」：
 * 一次性的、要读很多东西才能答的活，烧在子代理身上，父任务只收结论。
 *
 * ── 为什么第一版只给「只读」──
 * 写操作牵出三件 v0 故意不碰的事：改动的**事务归属**（一个还是两个）、
 * **跨子代理写同一文件**的串行化、**权限怎么转发**。只读能让这条路**零风险**
 * 地先跑通，也正好命中 `improvement-checklist.md` §2「长任务上下文断层」。
 *
 * ── 三条坑，都在这儿守住 ──
 *   ① **事件 key 必须是子代理自己的**（`traceId`）。沿用父的 key 的话，
 *      子代理跑完那句 `life.mark('completed')` 会把**父任务**的状态机打成终态，
 *      之后父任务任何转移都被静默拒绝、还不发事件 —— 这就是 AG-043 那类 bug
 *      （「UI 显示空闲、后台在跑」）。
 *   ② **不能走 `loop-run.run`**：那个外壳会给子代理 `begin` 一个改动事务、
 *      还会尝试「接回旧任务」。子代理只读、且有自己的任务，用不上这些 ——
 *      所以这里**直接调 `runLoop`**。
 *   ③ **只读靠咽喉、不靠提示词**：`permission:'readonly'` + `allowWrite:false`
 *      会在 `tools/index.cjs` 的两道闸上拦住写工具，**即使模型或注入让它写**。
 *
 * 深度最多 1 层（子代理不能再派子代理）—— 防 fork bomb。
 * 用法量的并入限制见 `budget.splitForChild` 的注释（父 `tokens` 暂不含子代理）。
 */

const log = require('./log.cjs')
const configCore = require('./config.cjs')
const taskCore = require('./task.cjs')
const budget = require('./budget.cjs')
const life = require('./lifecycle.cjs')

/** 子代理默认最多几轮（保险丝；父有更小上限时取更小的） */
const DEFAULT_MAX_TURNS = 8
/** 带回来的结论最多多少字符（超了中间截断，保住头尾） */
const RESULT_LIMIT = 8000

/**
 * 给子代理切一份预算。
 *
 * 语义：子代理有**自己的轮数硬上限**（保险丝，防它跑飞）；父任务有更小的轮数
 * 上限时**取更小的那个** —— 子代理不许花得比父允许的还多。token / 时长 /
 * 工具次数 v0 不给子代理单独设（0 = 不限），靠轮数兜底。
 *
 * ⚠️ 子代理的**实际用量**记在子任务自己的台账上（可单独归因），**不并回父任务的
 * `tokens` 总数** —— 父循环每轮 `turn_end` 都用 `base + 本次累计` **覆盖** tokens，
 * 中途并回去会被下一次写入抹掉；留一个**错的数字**比留一个不含子代理的数字更糟。
 * 要正确并入得改 `loop-run.cjs` 的用量基座，那超出 v0 范围。父任务台账里仍能看到
 * 这次调用（`steps` 里有 `spawn_subagent`）。
 */
function splitForChild(parentPlan, { maxSteps = DEFAULT_MAX_TURNS } = {}) {
  const cap = Math.max(1, Math.floor(Number(maxSteps) || DEFAULT_MAX_TURNS))
  const parentSteps = Number(parentPlan?.maxSteps) || 0
  const steps = parentSteps > 0 ? Math.min(parentSteps, cap) : cap
  const retries = Number(parentPlan?.maxRetries)
  return {
    ...budget.DEFAULTS,
    maxSteps: steps,
    maxRetries: Number.isFinite(retries) ? retries : budget.DEFAULTS.maxRetries,
  }
}

/** 结论太长就掐中间：头一段 + 尾一段（跟工具输出一个路子） */
function clip(text) {
  const value = String(text ?? '')
  if (value.length <= RESULT_LIMIT) return value
  const head = Math.floor(RESULT_LIMIT * 0.7)
  const tail = RESULT_LIMIT - head
  return `${value.slice(0, head)}\n\n…（子代理结论过长，中间省略 ${
    value.length - RESULT_LIMIT
  } 字符）…\n\n${value.slice(-tail)}`
}

/**
 * 派一个子代理。
 *
 * @param {{ task: string, ctx: object, config?: object }} input
 *   `task` = 让子代理做的事（一句话说清要它回答什么、去哪找）；
 *   `ctx`  = 父任务这次运行的 ctx（取 workdir / sessionId / taskId / signal / confirm）；
 *   `config` = 可选，注入配置（自检用；不传就取进程当前配置）
 * @returns {Promise<{ ok: boolean, taskId?: string, content?: string, usage?: object,
 *                     turns?: number, error?: string }>}
 */
async function spawn({ task, ctx, config: configOverride } = {}) {
  const taskText = String(task ?? '').trim()
  if (!taskText) return { ok: false, error: 'task 不能为空，请写清要子代理做什么。' }

  const parentTaskId = String(ctx?.taskId ?? '')
  const parent = parentTaskId ? taskCore.get(parentTaskId) : null

  /* 深度最多 1 层：父任务自己已经是子代理时，不许再派 */
  if (parent && parent.parentTaskId) {
    return { ok: false, error: '子代理不能再派子代理（深度最多 1 层）。这一层请自己做。' }
  }

  const config = configOverride ?? configCore.get()
  const mode = parent?.mode || 'pair'
  const workdir = String(ctx?.workdir ?? '')
  const sessionId = String(ctx?.sessionId ?? '')

  /* 先把子任务立起来（有自己的 id / 台账 / 预算）—— 建不出来就别往后走 */
  let child
  try {
    child = taskCore.create({
      goal: taskText,
      sessionId,
      workdir,
      mode,
      parentTaskId,
      budget: splitForChild(budget.resolve(config, parent), { maxSteps: DEFAULT_MAX_TURNS }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `没法给子代理立台账：${message}` }
  }

  /* 子代理的配置：只读。两道闸都在 tools/index.cjs —— 不靠提示词 */
  const subConfig = { ...config, tools: { ...config.tools, permission: 'readonly' } }
  /* ★ 事件 key 用子代理自己的（坑①）*/
  const traceId = `sub_${child.id}`
  const childEvents = []
  /*
   * 子代理 v1：它内部**每一步**都实时转给界面（转发器由 `tool-runner.cjs` 注入，
   * 带上父侧那次调用的 `toolCallId`）—— 没注入就退化成 v0，只攒不发
   * （自检 / 无界面场景）。
   *
   * ★ 只转 `agent.tool.*`：`content` / `reasoning` 是流式增量，一条回答几万条，
   *   转出去只会把界面淹掉，而且它们说不出「子代理在干什么」。
   */
  const forward = typeof ctx?.subagentEmit === 'function' ? ctx.subagentEmit : null

  /** 起止边界：子代理一个工具都没调时，界面照样知道它开过、结束了 */
  const notify = (payload) => {
    if (!forward) return
    try {
      forward({ subagentTaskId: child.id, ...payload })
    } catch {
      /* 事件是旁路 —— 界面看不见不许影响子代理把活干完 */
    }
  }

  const childEmit = (event) => {
    childEvents.push(event)
    if (!forward) return
    const type = String(event?.type ?? '')
    /*
     * 只认三种「一次工具调用」。**不能**按 `agent.tool.` 前缀一把捞：
     * `agent.tool.progress`（长任务自报进度）也吃这个前缀，捞进来会变成一条
     * 没有 id、tool 为空的假「完成」步 —— 界面上多出一行谁也看不懂的东西。
     */
    if (
      type !== 'agent.tool.started' &&
      type !== 'agent.tool.completed' &&
      type !== 'agent.tool.failed'
    ) {
      return
    }
    try {
      forward({
        subagentTaskId: child.id,
        kind: 'step',
        step: {
          /* 子代理自己的 toolCallId —— 界面靠它把 started / completed 认成同一行 */
          id: String(event.toolCallId ?? ''),
          at: Date.now(),
          tool: String(event.name ?? ''),
          args: event.args ?? {},
          phase:
            type === 'agent.tool.started'
              ? 'started'
              : type === 'agent.tool.failed'
                ? 'failed'
                : 'completed',
          ok: event.ok !== false,
          ms: typeof event.ms === 'number' ? event.ms : undefined,
        },
      })
    } catch (error) {
      log.warn(`转发子代理步骤失败：${error instanceof Error ? error.message : error}`)
    }
  }

  /* 惰性 require：loop.cjs 会 require 到 tools（其中就有本模块的工具），顶层引会成环 */
  const { runLoop } = require('./loop.cjs')

  notify({ kind: 'start', goal: taskText })

  try {
    const result = await runLoop({
      history: [{ role: 'user', content: taskText }],
      config: subConfig,
      workdir,
      mode,
      /* 父没给 signal（比如自检）也要有一个 —— runLoop 会读 `signal.aborted` */
      signal: ctx?.signal ?? new AbortController().signal,
      /* 子代理的事件：一边攒（v0 语义：调用方知道它动过），一边由 childEmit 实时转给界面 */
      emit: childEmit,
      /* ★ 安全红线：需要批准时**由父任务转发给用户本人**（拿父的 confirm），
         绝不「父批过 → 子自动批」—— 那等于给模型一个洗权限的装置。 */
      confirm: ctx?.confirm,
      threadSettings: { allowWrite: false, useMemory: false, allowTools: true },
      sessionId,
      goal: taskText,
      taskId: child.id,
      traceId,
      taskState: '',
    })

    const content = clip(result?.content)
    notify({ kind: 'done', status: 'completed', turns: result?.turns ?? 0 })
    try {
      taskCore.finish(child.id, { status: 'completed', result: content })
    } catch (error) {
      log.warn(`收尾子任务失败：${error instanceof Error ? error.message : error}`)
    }
    return {
      ok: true,
      taskId: child.id,
      content,
      usage: result?.usage ?? null,
      turns: result?.turns ?? 0,
      events: childEvents.length,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const aborted = error instanceof Error && error.name === 'AbortError'
    try {
      if (aborted) taskCore.update(child.id, { status: 'paused', pausedAt: Date.now() })
      else taskCore.fail(child.id, message)
    } catch {
      /* 台账写不进去不影响把错误带回父任务 */
    }
    notify({ kind: 'done', status: 'failed' })
    life.mark(aborted ? 'cancelled' : 'failed', traceId)
    log.warn(`子代理没跑完：${message}`)
    return { ok: false, taskId: child.id, error: message }
  }
}

module.exports = { spawn, splitForChild, DEFAULT_MAX_TURNS, RESULT_LIMIT }
