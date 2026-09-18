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
const { isAborted } = require('./abort.cjs')

/**
 * @param {{ toolCalls: Array, ctx: object, options: object, messages: Array,
 *           toolRuns: Array, emit: Function, turn: number }} input
 * @returns {Promise<{ touched: boolean }>}
 */
async function executeToolCalls({ toolCalls, ctx, options, messages, toolRuns, emit, turn }) {
  let touchedFiles = false
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

    const output = await tools.execute(call.name, args, ctx)

    const ok = !output.startsWith('错误：') && !output.startsWith('用户拒绝了')
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
