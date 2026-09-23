/*
 * Agent 循环。
 *
 * 一轮对话 = 若干「回合」：调模型 → 要工具 → 执行 → 结果喂回去 → … → 不再要工具。
 * 两个硬边界：maxTurns 防烧 token；AbortSignal 让「停止」立刻停住（含 shell）。
 * 状态由 AG-001 的 lifecycle 驱动（每次转移都发事件，UI 只读不猜）。
 */

const tools = require('./tools/index.cjs')
const stats = require('./stats.cjs')
const budget = require('./budget.cjs')
const loopGuard = require('./loop-guard.cjs')
const log = require('./log.cjs')
const taskCore = require('./task.cjs')
const taskResume = require('./task-resume.cjs')
const taskContext = require('./task-context.cjs')
const life = require('./lifecycle.cjs')
const skillPin = require('./skill-pin.cjs')
const taskPresets = require('./task-presets.cjs')
const changeset = require('./changeset.cjs')
/* run() 的形参也叫 config，模块得换名引 —— 否则 config.hasKey() 会在普通对象上调用。 */

const configCore = require('./config.cjs')
const router = require('./router.cjs')
const {
  callModel,
  reviewWithEvents,
  mergeUsage,
  pausedResult,
  exhaustedResult,
} = require('./loop-model.cjs')
const { buildPromptContext } = require('./loop-prompt.cjs')
const { executeToolCalls } = require('./loop-tools.cjs')
const { resolveRoute } = require('./loop-route.cjs')
const limits = require('./limits.cjs')
const modeRouter = require('./mode-router.cjs')
/*
 * 失控兜底轮数（AG-040）：用户看得见的边界是任务预算的 maxSteps（默认 50，那项负责
 * 「停下来问你」），这个 200 只防「预算设成不限而模型抽风」。★ 两个机制不能做同一件事：
 * 第一版这里设成 50，结果「轮数到顶」总被 for 条件先拦下，预算检查没机会带 budgetHit。
 */
const MAX_TURNS = 200

/** AG-041：重复执行顶几次就停下来问用户（第 1 次只是「改道」） */
const LOOP_NUDGE_LIMIT = 2

/* ══════════════════════════════════════════════════════════
   主循环
   ══════════════════════════════════════════════════════════ */

/*
 * 状态事件的 key。**不能用 options.taskId**（那是任务台账 id，run() 里还会换成 task.id；
 * 调用方按自己的 requestId 过滤，两边对不上事件就全丢 → 「UI 显示空闲、后台在跑」）。
 */
function traceKey(options) {
  return (typeof options.traceId === 'string' && options.traceId) || options.taskId || ''
}

/** 真正的循环。包一层 run() 是为了把「任务/事务的开始与收尾」集中在一处，不用在十几种出口上各写一遍 */
async function runLoop(options) {
  const { history, config, workdir, mode, signal, emit, confirm } = options
  const threadSettings = options.threadSettings ?? {}
  const provider = config.activeProvider ? config.activeProvider : configCore.activeProvider()

  if (!provider) throw new Error('没有可用的供应商')
  if (!configCore.hasKey(provider)) throw new Error(`${provider.name} 还没填 API Key`)

  const {
    userText,
    provider: useProvider,
    model: useModel,
  } = resolveRoute({
    config,
    provider,
    options,
    emit,
  })
  /* AG-035：记下是哪只模型在干这个活（诊断报告要写它） */
  if (options.taskId) taskCore.recordModel(options.taskId, useModel)

  /* 环境 / 工具清单 / 记忆 / 项目说明 / 分层系统提示 —— 见 loop-prompt.cjs */
  const { messages, promptVersion } = buildPromptContext({
    config, workdir, mode, history, threadSettings, options,
  })
  /* ②-1：提示词版本也记进台账（和模型一样，是「为什么这次不一样」的线索） */
  if (options.taskId) taskCore.recordPromptVersion(options.taskId, promptVersion)

  const ctx = {
    workdir,
    sessionId: options.sessionId ?? '',
    taskId: options.taskId ?? '',
    changeSetId: options.changeSetId ?? '',
    permission: config.tools.permission,
    /* 用户约束是运行时约束，不依赖模型遵守 Prompt。 */
    allowTools: threadSettings.allowTools !== false,
    allowWrite:
      threadSettings.allowWrite !== false &&
      mode !== 'plan' &&
      !/(只分析|不要修改|禁止修改|不许写|不要写文件|不执行修改)/.test(userText),
    allowNetwork:
      threadSettings.allowNetwork !== false && !/(不联网|不要联网|禁止联网|离线)/.test(userText),
    temporary: options.temporary === true,
    shellTimeout: config.tools.shellTimeout,
    shellPolicy: config.tools.shellPolicy,
    fileScope: config.tools.fileScope,
    outputLimit: config.tools.outputLimit,
    /* 技能钉到这次对话时，它的 network 声明会在这里生效（见 skill-pin.cjs） */
    signal, confirm, log, ...skillPin.ctxGrant(threadSettings),
    granted: new Map() /* AG-013：「允许本次」的批准时刻，见 tools/approval.cjs */,
  }

  let totalUsage = null
  const toolRuns = []
  let turn = 0
  /* 完成门禁的状态：顶回去几次、上一轮的进度快照（两个刹车都靠它） */
  let gateSeen = {}
  /* AG-041：重复执行顶回去几次（超过阈值就停下来问用户） */
  let loopNudges = 0
  /* AG-001：状态由引擎驱动（以前是前端自己 setThreadStatus） */
  life.mark('preparing', traceKey(options))

  /* AG-040：这次任务的预算（内置默认 ← 设置 ← 任务自己的覆盖） */
  const plan = budget.resolve(config, taskCore.get(options.taskId) ?? null)
  const startedAt = Date.now()

  for (; turn < MAX_TURNS; turn += 1) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')

    /* AG-011：优雅暂停 —— 每轮开头 = 上一轮工具已全跑完（即「完成当前安全操作」） */
    if (options.controls?.pauseRequested?.()) {
      life.mark('paused', traceKey(options))
      return pausedResult({ turn, usage: totalUsage, toolRuns })
    }
    /* AG-041：轮次边界查重复（工具已跑完，这一批签名才齐）；先改道，几次不听才交人 */
    const loopHit = loopGuard.detect(loopGuard.signaturesOf(toolRuns))
    if (loopHit.looping && loopNudges >= LOOP_NUDGE_LIMIT) {
      emit({ type: 'loop', ...loopHit, handedOver: true })
      /* ★ 用 paused 不用 waiting_user（AG-043 真机）：后者在渲染层算「还在跑」
         （AG-011 为权限确认定的），而这里 run 已结束 —— 用它 Composer 会一直
         显示「停止生成」，用户没法直接打字说「改成别的」。 */
      life.mark('paused', traceKey(options))
      return exhaustedResult({ turn, usage: totalUsage, toolRuns, maxTurns: turn, loopHit })
    }
    if (loopHit.looping) {
      loopNudges += 1
      emit({ type: 'loop', ...loopHit, handedOver: false, nudge: loopNudges })
      messages.push({ role: 'user', content: loopGuard.nudgeMessage(loopHit) })
    }

    /* AG-040：轮次边界查一次预算（每轮开头 = 上一轮工具已跑完，不会停在改了一半的状态） */
    const hit = budget.atTurnBoundary({ plan, startedAt, turn, toolRuns, usage: totalUsage })
    if (hit.exceeded) {
      emit({ type: 'budget', ...hit, blocked: false })
      /* 同上：撞预算也是「停下来了」，不是「还挂着在等你确认」 */
      life.mark('paused', traceKey(options))
      return exhaustedResult({ turn, usage: totalUsage, toolRuns, maxTurns: turn, budgetHit: hit })
    }
    /* 用量闸（全局，按天/月）：调模型**之前**查账（唯一能真省钱的位置） */
    limits.enforce(emit)
    life.mark('thinking', traceKey(options))
    emit({ type: 'turn_start', turn: turn + 1 })

    /* ── 调模型（带重试与降级）── */
    const result = await callModel({
      config,
      provider: useProvider,
      model: useModel,
      messages,
      tools: tools.toApiSchema(),
      /* ②-2：温度可以在这条对话上单独设（任务类型预设），没设就用全局的 */
      temperature: taskPresets.temperatureOf(threadSettings, config),
      topP: config.assistant.topP,
      maxTokens: config.assistant.maxTokens,
      /* 思考强度档位（thread 里选的 low/high/max）—— 以前这里漏了，档位从没传给模型 */
      reasoningEffort: threadSettings.reasoning,
      /* AG-037 埋点顺手逮到的：callModel 里一直写着 `emit?.(…)` 报重试/降级/上下文超限，
         而调用方**从来没把 emit 传进来** —— 那些提示在界面上从未出现过（AG-016 要求告知用户） */
      traceId: traceKey(options),
      emit,
      signal,
      /* AG-040：自动重试次数由预算决定（默认 3） */
      maxRetries: plan.maxRetries,
      onContent: (text) => emit({ type: 'content', text }),
      onReasoning: (text) => emit({ type: 'reasoning', text }),
      onUsage: (usage) => {
        totalUsage = mergeUsage(totalUsage, usage)
        /* 每次 LLM 调用都要记一笔 —— 一轮 agent 循环里可能调好几次，分开算才准 */
        try {
          stats.record(usage, useModel)
        } catch (error) {
          log.warn(`记用量失败：${error instanceof Error ? error.message : error}`)
        }
      },
    })

    if (result.usage && !totalUsage) totalUsage = result.usage

    /* ── 计划（AG-004）：每轮都给 capturePlan 看，变了才发事件（细节见 task-context.cjs） ── */
    if (result.content) {
      const captured = taskContext.capturePlan({
        taskId: options.taskId ?? '',
        content: result.content,
      })
      if (captured) emit({ type: 'plan', ...captured })
    }

    /* ── 没有工具调用 → 这轮结束 ── */
    if (result.toolCalls.length === 0) {
      life.mark('verifying', traceKey(options))
      /* 完成门禁：计划没勾完就想收工 → 顶回去继续（刹车在 task-context.cjs） */
      const gate = taskContext.shouldContinue({
        taskId: options.taskId ?? '',
        content: result.content ?? '',
        seen: gateSeen,
      })
      if (gate.continue) {
        gateSeen = gate.seen
        messages.push({ role: 'assistant', content: result.content ?? '' })
        messages.push({ role: 'user', content: gate.message })
        continue
      }

      /* 收尾前打最后一个检查点，写明「到这为止是好的」 */
      if (options.taskId) {
        try {
          taskCore.checkpoint(options.taskId, {
            label: `第 ${turn + 1} 轮结束`,
            note: result.content?.slice(0, 300) ?? '',
          })
        } catch {
          /* 台账写不进去不影响回答 */
        }
      }
      emit({ type: 'turn_end', turn: turn + 1, usage: totalUsage })
      life.mark('responding', traceKey(options))
      /* 自检复核（开关、事件、失败保留原回答都在里面） */
      const finalContent = await reviewWithEvents({
        config,
        provider: useProvider,
        model: useModel,
        content: result.content,
        userText,
        signal,
        mode,
        emit,
      })
      life.mark('completed', traceKey(options))
      return {
        content: finalContent,
        reasoning: result.reasoning,
        usage: totalUsage,
        turns: turn + 1,
        toolRuns,
      }
    }

    /* AG-010：读流结束到开始执行工具之间也要查中断（真机：停止后 2.7 秒仍发起新工具） */
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

    /* ── 有工具调用：把 assistant 这条带 tool_calls 的消息存进历史 ── */
    life.mark('executing', traceKey(options))
    messages.push({
      role: 'assistant',
      content: result.content || '',
      tool_calls: result.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    })

    emit({ type: 'turn_end', turn: turn + 1, usage: totalUsage })

    /* 这一轮的工具逐个执行（含任务台账 / 检查点）—— 见 loop-tools.cjs */
    await executeToolCalls({
      toolCalls: result.toolCalls,
      ctx,
      options: { ...options, budget: plan } /* AG-040：工具自动重试次数用它 */,
      messages,
      toolRuns,
      emit,
      turn,
    })
  }

  /* 保险丝烧了（预算设成「不限」而模型一直不罢休）—— 这不是预算停下来那一步 */
  emit({ type: 'turn_end', turn: MAX_TURNS, usage: totalUsage })
  return exhaustedResult({ usage: totalUsage, toolRuns, maxTurns: MAX_TURNS })
}

/*
 * `run` 现在住在 loop-run.cjs（那边还管任务与事务的开始/收尾）。
 * 惰性 require 破循环：loop-run 要用这里的 runLoop，这里要用那边的 run。
 */
module.exports = {
  run: (...args) => require('./loop-run.cjs').run(...args),
  runLoop,
  MAX_TURNS,
}
