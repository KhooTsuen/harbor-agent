/**
 * 执行模型这一轮要的工具。
 *
 * 从 loop.cjs 拆出来的（那边过 300 行了）。
 *
 * 返回值带 `touched`：这一轮有没有真的改过文件 —— 调用方拿它决定要不要打检查点
 * （打了才能在崩了之后恢复到「上次是好的」那个点）。
 *
 * 每个工具的结果都会：
 *   · 推给界面（agent.tool.started / agent.tool.completed / agent.tool.failed）
 *   · 记进任务台账（做了什么、成功没、改了哪些文件）
 *   · 作为 tool 消息喂回模型
 */

const log = require('./log.cjs')
const tools = require('./tools/index.cjs')
const taskCore = require('./task.cjs')
const errors = require('./errors.cjs')
const toolFailure = require('./tool-failure.cjs')
const experience = require('./experience-loop.cjs')
const { buildFailureNote } = require('./loop-prompt.cjs')
const { isAborted } = require('./abort.cjs')
/* 与 `tool-runner` 同一套注入（progress / subagentEmit）与同一个 Action 组装入口 */
const { buildRunCtx } = require('./tool-run-ctx.cjs')
const actionCore = require('./action.cjs')
const { lastUserText } = require('./loop-route.cjs')
const { retryLink } = require('./tool-retry-link.cjs')

/* 成败判定与失败事实都只定义在 `tool-failure.cjs`；这里只接线（两份执行器共用） */
const { isToolOk, outTextOf } = toolFailure

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {{ toolCalls: Array, ctx: object, options: object, messages: Array,
 *           toolRuns: Array, emit: Function, turn: number }} input
 * @returns {Promise<{ touched: boolean }>}
 */
async function executeToolCallsSerial({ toolCalls, ctx, options, messages, toolRuns, emit, turn }) {
  let touchedFiles = false
  /* AG-017：本轮的成败名单 —— 结尾要拿它给模型一句「进度对照」 */
  const doneNames = []
  const failures = []
  for (const call of toolCalls) {
    /*
     * AG-010：模型一轮可能给好几个 tool_call。用户在第 1 个执行中点停止时，
     * 剩下的**不许再发起** —— 文档验收就是「Stop 后 5 秒内不得继续出现新的
     * Agent Tool Call」。但每个 tool_call 都要补一条 tool 消息：OpenAI 协议
     * 要求一一对应，缺了下一轮请求会被 400，模型也会以为工具还没回话。
     */
    if (isAborted(ctx.signal)) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: '用户中断了这次执行，这个工具没有运行。',
      })
      continue
    }

    let args = {}
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {}
    } catch {
      emit({
        type: 'agent.tool.failed',
        toolCallId: call.id,
        name: call.name,
        ok: false,
        result: '参数不是合法 JSON，无法解析',
      })
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: '错误：工具参数不是合法 JSON。请重新调用，arguments 必须是 JSON 字符串。',
      })
      continue
    }

    const startedAt = Date.now()

    /*
     * 这次调用专用的 ctx + 这次调用的 Action —— 与 `tool-runner.runOne()` **同一套**。
     *
     * ★ 这里原来直接传 `ctx`，于是串行路径少了三样并行路径有的东西：
     *   · `ctx.action`  → 各 gate 的 `actionCore.notePermission` 静默不记（Action 面板空白）
     *   · `ctx.progress` / `ctx.subagentEmit` → 工具报的进度与子代理步骤全丢
     * ★ `wantMeta: true` 更要紧，见下面 `tools.execute` 那段。
     */
    const action = actionCore.of({
      name: call.name,
      args,
      workdir: ctx?.workdir ?? '',
      userText: typeof options?.authorizationText === 'string' ? options.authorizationText : lastUserText(options?.history),
    })
    const retryLinkage = retryLink(toolRuns, call, args)
    emit({
      type: 'agent.tool.started',
      toolCallId: call.id,
      name: call.name,
      args,
      action,
      ...retryLinkage,
    })
    const runCtx = buildRunCtx(ctx, { emit, toolCallId: call.id, toolName: call.name })
    runCtx.action = action

    /*
     * AG-016：失败后自动恢复（文档策略表里的 FileChanged→重新读取、
     * Timeout / Network→有限 Retry）。
     *
     * ★ 只对**只读**工具做 —— 理由在 `errors.canAutoRecover`：
     *   `run_shell` 超时后自动重试等于把命令再跑一遍，那不是恢复是重复副作用。
     *   写操作交给模型判断（AG-015 已经把分类和建议喂给它了）。
     *
     * ★★ `wantMeta: true` 不是可选项（2026-11-05 P2 实测）：
     *   `tools.execute` 的契约是「`ctx.wantMeta === true` 才返回 `{ text, toolOk, exitCode… }`，
     *   否则只返回**字符串**」。串行这份以前没传，于是同一条 `node -e "process.exit(1)"`：
     *     并行 → `toolOk:false` + `facts.exitCode=1` → 判失败（红）
     *     串行 → 纯文本 `…[退出码 1]`，前缀不是「错误：」 → `isToolOk` 判**成功**（绿勾）
     *   这正是 `tool-failure.cjs` 文件头写的那个绿勾病 —— 并行修了、串行漏了。
     *   两处必须一致：`isToolOk` 只能有一个判据，喂给它的东西也必须同形。
     */
    let output = await tools.execute(call.name, args, { ...runCtx, wantMeta: true })
    /* AG-040：重试次数上限来自任务预算（默认 3），不再写死 */
    const maxRetries = Number.isFinite(options.budget?.maxRetries)
      ? Math.max(0, options.budget.maxRetries)
      : errors.MAX_AUTO_RETRY
    let autoRetries = 0
    for (let retry = 0; retry < maxRetries && !isToolOk(output); retry += 1) {
      /* 分类吃的是**正文**（结构化返回里 `text` 才是正文）—— 与并行那份同一句 */
      const retryInfo = errors.classifyToolOutput(outTextOf(output), { name: call.name })
      if (!errors.canAutoRecover(retryInfo, call.name)) break
      autoRetries += 1
      /* AG-002 定义的 agent.retrying —— 界面和日志都看得到「它在自己重试」 */
      emit({
        type: 'agent.retrying',
        toolCallId: call.id,
        name: call.name,
        attempt: retry + 1,
        kind: retryInfo.kind,
        hint: retryInfo.hint,
      })
      await sleep(errors.backoffMs(retry, retryInfo.kind))
      output = await tools.execute(call.name, args, { ...runCtx, wantMeta: true })
    }

    const ok = isToolOk(output)
    const outText = outTextOf(output)
    if (ok) doneNames.push(call.name)
    /* 失败事实：形状只定义在 tool-failure.cjs，事件 / 台账 / 记录读同一份 */
    const { info, error: failure } = toolFailure.outcomeOf({
      toolName: call.name,
      ok,
      text: outText,
      facts: toolFailure.factsOf(output),
    })
    const run = {
      id: call.id,
      name: call.name,
      args,
      ok,
      ...retryLinkage,
      output: outText,
      ms: Date.now() - startedAt,
      /* 结构化事实（退出码 / 超时 / 中断）：独立验证器读它，不读正文 —— 与并行版同形 */
      facts: toolFailure.factsOf(output),
      ...(failure ? { error: failure } : {}),
    }
    toolRuns.push(run)

    /*
     * 自我纠错：**与 `tool-runner` 同一个入口、同一份判据**（`experience.afterRun`）。
     *
     * 这里以前没接，理由是「它没有调用方」—— 但这正是硬约束 9 说的那种病：
     * 同一职责的第二份实现摆在那儿，哪天谁切回串行，经验层就在那条路上静默失效
     * （不报错、不记日志、只是什么都学不到）。既然它导出了，就得和并行那份同语义。
     */
    const learned = experience.afterRun(run, {
      projectId: ctx?.projectId,
      sessionId: ctx?.sessionId,
      workdir: ctx?.workdir,
    })

    /* ── 任务台账：这一步干了什么 ── */
    if (options.taskId) {
      try {
        taskCore.addStep(options.taskId, {
          tool: call.name,
          ok,
          summary: outText,
          ms: run.ms,
          args,
          error: failure,
        })
        if (call.name === 'run_shell' && typeof args.command === 'string') {
          taskCore.addCommand(options.taskId, args.command, outText)
        }
        if (
          typeof args.path === 'string' &&
          (call.name === 'write_file' || call.name === 'edit_file')
        ) {
          taskCore.addChangedFile(options.taskId, args.path)
          touchedFiles = true
        }
      } catch (error) {
        log.warn(`写任务台账失败：${error instanceof Error ? error.message : error}`)
      }
    }

    /*
     * AG-002：成败写在事件名里；AG-015：失败时带分类（界面据此说人话）。
     * 分类来自 `toolFailure.outcomeOf`（上面已经算好），这里不再算第二遍。
     */
    emit({
      type: ok ? 'agent.tool.completed' : 'agent.tool.failed',
      toolCallId: call.id,
      name: call.name,
      ok,
      result: outText,
      ms: run.ms,
      ...retryLinkage,
      retryAttempt: autoRetries,
      ...(info ? { errorKind: info.kind, errorHint: info.hint } : {}),
      ...(failure ? { error: failure } : {}),
    })

    /* 工具结果喂回模型（失败时附上分类与建议，它才知道该换个做法） */
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: info
        ? [
            `${outText}\n\n[错误分类] ${info.kind} —— ${info.hint}。建议：${
              errors.STRATEGY_TEXT[info.strategy] ?? info.strategy
            }`,
            /* 验过的经验才在这里出现（候选不进提示）—— 与 tool-runner 同一句口径 */
            ...(learned.note ? [learned.note] : []),
          ].join('\n')
        : outText,
    })
    if (info) failures.push({ name: call.name, hint: info.hint })
  }

  /*
   * AG-017：本轮有失败 → 给模型一句「什么成了、什么败了」。
   *
   * 它明明能看到历史里的成功步骤，为什么还要写这一句？因为**历史会被压缩**
   * （AG-016 的 ContextOverflow → Compact）：压完之后早期步骤只剩摘要里的
   * 一句话，模型有可能会「保险起见从头再来」。任务台账在磁盘上、不受压缩影响，
   * 所以在这里把进度再说一遍，并直说「成功的别重做」。
   */
  if (failures.length > 0) {
    const note = buildFailureNote({ done: doneNames, failed: failures })
    messages.push({ role: 'user', content: note })
    /* 留个痕 —— 诊断时能确认这句话真的进了模型上下文（messages 不落盘） */
    log.info(`失败后继续：已完成 ${doneNames.length} 步，失败 ${failures.length} 步`)
  }

  /* 这一轮真动过文件 → 打一个检查点（崩了从这裏恢复） */
  if (options.taskId && touchedFiles) {
    try {
      taskCore.checkpoint(options.taskId, { label: `第 ${turn + 1} 轮改动完成` })
    } catch {
      /* 台账写不进去不影响对话 */
    }
    touchedFiles = false
  }

  return { touched: touchedFiles }
}

/* token 优化：默认走 tool-runner 的并行执行器；本文件的串行实现保留作回退/对照 */
module.exports = { ...require('./tool-runner.cjs'), executeToolCallsSerial }
