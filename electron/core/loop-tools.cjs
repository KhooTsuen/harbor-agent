/**
 * 执行模型这一轮要的工具。
 *
 * 从 loop.cjs 拆出来的（那边过 300 行了）。
 *
 * 返回值带 `touched`：这一轮有没有真的改过文件 —— 调用方拿它决定要不要打检查点
 * （打了才能在崩了之后恢复到「上次是好的」那个点）。
 *
 * 每个工具的结果都会：
 *   · 推给界面（tool_start / tool_end）
 *   · 记进任务台账（做了什么、成功没、改了哪些文件）
 *   · 作为 tool 消息喂回模型
 */

const log = require('./log.cjs')
const tools = require('./tools/index.cjs')
const taskCore = require('./task.cjs')

/**
 * @param {{ toolCalls: Array, ctx: object, options: object, messages: Array,
 *           toolRuns: Array, emit: Function, turn: number }} input
 * @returns {Promise<{ touched: boolean }>}
 */
async function executeToolCalls({ toolCalls, ctx, options, messages, toolRuns, emit, turn }) {
  let touchedFiles = false

  for (const call of toolCalls) {
    let args = {}
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {}
    } catch {
      emit({
        type: 'tool_end',
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

    emit({ type: 'tool_start', toolCallId: call.id, name: call.name, args })
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

    emit({ type: 'tool_end', toolCallId: call.id, name: call.name, ok, result: output, ms: run.ms })

    /* 工具结果喂回模型 */
    messages.push({ role: 'tool', tool_call_id: call.id, content: output })
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
