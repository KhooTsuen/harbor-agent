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
const { buildFailureNote } = require('./loop-prompt.cjs')
const { isAborted } = require('./abort.cjs')

/** 工具返回算不算成功 —— 全项目只有这一处判定 */
function isToolOk(output) {
  const text = String(output ?? '')
  return !text.startsWith('错误：') && !text.startsWith('用户拒绝了')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {{ toolCalls: Array, ctx: object, options: object, messages: Array,
 *           toolRuns: Array, emit: Function, turn: number }} input
 * @returns {Promise<{ touched: boolean }>}
 */
async function executeToolCalls({ toolCalls, ctx, options, messages, toolRuns, emit, turn }) {
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

    emit({ type: 'agent.tool.started', toolCallId: call.id, name: call.name, args })
    const startedAt = Date.now()

    /*
     * AG-016：失败后自动恢复（文档策略表里的 FileChanged→重新读取、
     * Timeout / Network→有限 Retry）。
     *
     * ★ 只对**只读**工具做 —— 理由在 `errors.canAutoRecover`：
     *   `run_shell` 超时后自动重试等于把命令再跑一遍，那不是恢复是重复副作用。
     *   写操作交给模型判断（AG-015 已经把分类和建议喂给它了）。
     */
    let output = await tools.execute(call.name, args, ctx)
    /* AG-040：重试次数上限来自任务预算（默认 3），不再写死 */
    const maxRetries = Number.isFinite(options.budget?.maxRetries)
      ? Math.max(0, options.budget.maxRetries)
      : errors.MAX_AUTO_RETRY
    for (let retry = 0; retry < maxRetries && !isToolOk(output); retry += 1) {
      const retryInfo = errors.classifyToolOutput(output, { name: call.name })
      if (!errors.canAutoRecover(retryInfo, call.name)) break
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
      output = await tools.execute(call.name, args, ctx)
    }

    const ok = isToolOk(output)
    if (ok) doneNames.push(call.name)
    const run = {
      id: call.id,
      name: call.name,
      args,
      ok,
      output,
      ms: Date.now() - startedAt,
    }
    toolRuns.push(run)

    /* ── 任务台账：这一步干了什么 ── */
    if (options.taskId) {
      try {
        taskCore.addStep(options.taskId, {
          tool: call.name,
          ok,
          summary: output,
          ms: run.ms,
          args,
        })
        if (call.name === 'run_shell' && typeof args.command === 'string') {
          taskCore.addCommand(options.taskId, args.command, output)
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
     * AG-002：成败写在事件名里（agent.tool.completed / agent.tool.failed）——
     * 前端不用再去读 ok 字段判成败，也方便日志和诊断直接按名字筛。
     */
    /*
     * AG-015：失败时给一句**分类判断**。
     *
     * 文档的「失败体验标准」里写着应该出现这种句子：
     *   Agent 判断：这是测试失败，不是执行环境错误。
     *
     * 不做这一步的话，模型看到一个「错误：…」只会原样重试 ——
     * 同一个坑里反复掉（这也正是 AG-017「失败后继续」要治的）。
     */
    const info = ok ? null : errors.classifyToolOutput(output, { name: call.name })

    emit({
      type: ok ? 'agent.tool.completed' : 'agent.tool.failed',
      toolCallId: call.id,
      name: call.name,
      ok,
      result: output,
      ms: run.ms,
      /* 失败分类：界面据此说人话，模型也看得到 */
      ...(info ? { errorKind: info.kind, errorHint: info.hint } : {}),
    })

    /* 工具结果喂回模型（失败时附上分类与建议，它才知道该换个做法） */
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: info
        ? `${output}\n\n[错误分类] ${info.kind} —— ${info.hint}。建议：${
            errors.STRATEGY_TEXT[info.strategy] ?? info.strategy
          }`
        : output,
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

module.exports = { executeToolCalls }
