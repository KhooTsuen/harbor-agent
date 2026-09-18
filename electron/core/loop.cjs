/**
 * Agent 循环
 *
 * 一轮对话 = 若干「回合」：调模型 → 要工具 → 执行 → 结果喂回去 → … → 不再要工具。
 * 两个硬边界：maxTurns 防止烧 token；AbortSignal 让「停止」能立刻停住（含 shell）。
 * 状态由 AG-001 的 lifecycle 驱动 —— 每次转移都会发事件，UI 只读不猜。
 */

const tools = require('./tools/index.cjs')
const stats = require('./stats.cjs')
const log = require('./log.cjs')
const taskCore = require('./task.cjs')
const taskContext = require('./task-context.cjs')
const life = require('./lifecycle.cjs')
const changeset = require('./changeset.cjs')
/* run() 的形参也叫 config，模块得换名引 —— 否则 config.hasKey() 会在普通对象上调用。 */

const configCore = require('./config.cjs')
const router = require('./router.cjs')
const { callModel, reviewWithEvents, mergeUsage } = require('./loop-model.cjs')
const { buildPromptContext } = require('./loop-prompt.cjs')
const { executeToolCalls } = require('./loop-tools.cjs')
const { resolveRoute } = require('./loop-route.cjs')
const limits = require('./limits.cjs')
const modeRouter = require('./mode-router.cjs')

const MAX_TURNS = 25

/* ══════════════════════════════════════════════════════════
   主循环
   ══════════════════════════════════════════════════════════ */

/**
 * @param {object} options
 * @param {Array} options.history      历史消息（含本轮用户输入）
 * @param {object} options.config      主进程配置
 * @param {string} options.workdir
 * @param {string} options.mode
 * @param {AbortSignal} options.signal
 * @param {(event: object) => void} options.emit     推给渲染层
 * @param {(req: object) => Promise<boolean>} options.confirm  写操作确认
 * @param {string} [options.sessionId]  会话 id（审计与授权用）
 * @param {string} [options.taskId]     任务 id（可恢复任务用）
 * @param {string} [options.goal]       本轮的原始目标（用户那句话）
 */
async function run(options) {
  /*
   * 一次 Agent 运行 = 一条任务 + 一个文件改动事务。
   *
   * 任务回答「干什么、到哪一步了、能不能继续」；事务回答「改了哪些文件、怎么整批撤」。
   * 两者都不进会话文件 —— 会话是聊天记录，不该兼任工作台账。
   */
  const goal = String(options.goal ?? '')
  const sessionId = options.sessionId ?? ''

  const task = taskCore.create({
    goal,
    sessionId,
    projectId: options.projectId,
    workdir: options.workdir,
    mode: options.mode,
    title: goal.slice(0, 60),
  })
  const session = changeset.begin({ taskId: task.id, sessionId, title: task.title })
  const changeSetId = session.ok ? session.id : ''

  options.emit?.({ type: 'task', taskId: task.id, changeSetId, goal: task.goal })

  try {
    const result = await runLoop({ ...options, taskId: task.id, changeSetId })

    if (changeSetId) changeset.commit(changeSetId, { verified: result.verified ?? null })

    if (result.exhausted) {
      /* 輪数用尽 = 活没干完，标成暂停让它可恢复 */
      taskCore.update(task.id, { status: 'paused' })
    } else {
      taskCore.finish(task.id, { status: 'completed', result: result.content ?? '' })
    }

    return { ...result, taskId: task.id, changeSetId }
  } catch (error) {
    /* 中断/报错都算「没干完」—— 任务留着可恢复，事务不提交（还能整批撤） */
    const aborted = error instanceof Error && error.name === 'AbortError'
    life.mark(aborted ? 'cancelled' : 'failed', options.taskId ?? '')
    if (aborted) taskCore.update(task.id, { status: 'paused' })
    else taskCore.fail(task.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}

/**
 * 真正的循环。包一层 run() 是为了把「任务/事务的开始与收尾」集中在一处，
 * 不用在十几种出口上各写一遍。
 */
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

  /* 环境 / 工具清单 / 记忆 / 项目说明 / 分层系统提示 —— 见 loop-prompt.cjs */
  const { messages } = buildPromptContext({
    config,
    workdir,
    mode,
    history,
    threadSettings,
    options,
  })

  const ctx = {
    workdir,
    /* 审计 / 授权 / 任务都靠这几个 id 串起来 */
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
    signal,
    confirm,
    log,
  }

  let totalUsage = null
  const toolRuns = []
  let turn = 0
  let planParsed = false
  /* 完成门禁的状态：顶回去几次、上一轮的进度快照（两个刹车都靠它） */
  let gateSeen = {}
  /* AG-001：状态由引擎驱动（以前是前端自己 setThreadStatus） */
  const tid = options.taskId ?? ''
  life.mark('preparing', tid)

  for (; turn < MAX_TURNS; turn += 1) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')

    /* 用量闸：调模型**之前**查账（唯一能真省钱的位置）。按 token 算，不按金额 */
    limits.enforce(emit)
    life.mark('thinking', tid)
    emit({ type: 'turn_start', turn: turn + 1 })

    /* ── 调模型（带重试与降级）── */
    const result = await callModel({
      config,
      provider: useProvider,
      model: useModel,
      messages,
      tools: tools.toApiSchema(),
      temperature: config.assistant.temperature,
      topP: config.assistant.topP,
      maxTokens: config.assistant.maxTokens,
      /* 思考强度档位（thread 里选的 low/high/max）—— 以前这里漏了，档位从没传给模型 */
      reasoningEffort: threadSettings.reasoning,
      signal,
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

    /* ── 计划 ── */
    if (!planParsed && result.content) {
      planParsed = true
      const plan = taskContext.capturePlan({
        taskId: options.taskId ?? '',
        content: result.content,
      })
      if (plan) emit({ type: 'plan', plan })
    }

    /* ── 没有工具调用 → 这轮结束 ── */
    if (result.toolCalls.length === 0) {
      life.mark('verifying', tid)
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
      life.mark('responding', tid)
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
      life.mark('completed', tid)
      return {
        content: finalContent,
        reasoning: result.reasoning,
        usage: totalUsage,
        turns: turn + 1,
        toolRuns,
      }
    }

    /* ── 有工具调用：把 assistant 这条带 tool_calls 的消息存进历史 ── */
    life.mark('executing', tid)
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
      options,
      messages,
      toolRuns,
      emit,
      turn,
    })
  }

  /* 轮数用尽 */
  emit({ type: 'turn_end', turn: MAX_TURNS, usage: totalUsage })
  return {
    content: `（已经连续调用工具 ${MAX_TURNS} 轮，先停在这里。你可以说「继续」让我接着做。）`,
    reasoning: '',
    usage: totalUsage,
    turns: MAX_TURNS,
    toolRuns,
    exhausted: true,
  }
}

module.exports = { run, runLoop, MAX_TURNS }
