const log = require('./log.cjs')
const tools = require('./tools/index.cjs')
const taskCore = require('./task.cjs')
const taskNotes = require('./task-notes.cjs')
const taskStrict = require('./task-strict.cjs')
const errors = require('./errors.cjs')
const observer = require('./error-observer.cjs')
const toolFailure = require('./tool-failure.cjs')
const scheduler = require('./tool-scheduler.cjs')
const shared = require('./tools/_shared.cjs')
const { buildFailureNote } = require('./loop-prompt.cjs')
const { isAborted } = require('./abort.cjs')
const { buildRunCtx } = require('./tool-run-ctx.cjs')
const actionCore = require('./action.cjs')
const experience = require('./experience-loop.cjs')
const { lastUserText } = require('./loop-route.cjs')
const { retryLink } = require('./tool-retry-link.cjs')
const { isToolOk, outTextOf } = toolFailure

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function targetOf(item) {
  const args = item?.args ?? {}
  if (typeof args.path === 'string') return args.path
  if (typeof args.dir === 'string') return args.dir
  if (typeof args.command === 'string') return args.command.slice(0, 80)
  if (typeof args.query === 'string') return args.query.slice(0, 80)
  return ''
}

/**
 * @param {{ toolCalls: Array, ctx: object, options: object, messages: Array,
 *           toolRuns: Array, emit: Function, turn: number }} input
 * @returns {Promise<{ touched: boolean }>}
 */
async function executeToolCalls({ toolCalls, ctx, options, messages, toolRuns, emit, turn }) {
  let touchedFiles = false
  const doneNames = []
  const failures = []
  const items = (toolCalls ?? []).map((call) => {
    let args = {}
    let bad = false
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {}
    } catch {
      bad = true
    }
    return { id: call.id, name: call.name, args, call, bad }
  })
  const writeSnap = scheduler.snapshotTargets(items, {
    resolve: (p) => {
      try {
        return shared.resolvePath(p, ctx.workdir, ctx)
      } catch {
        return p
      }
    },
  })
  const batches = scheduler.planBatches(items)
  const runOne = async (item, { parallel }) => {
    const call = item.call
    const args = item.args

    if (isAborted(ctx.signal)) {
      return {
        role: 'tool',
        tool_call_id: call.id,
        content: '用户中断了这次执行，这个工具没有运行。',
      }
    }

    if (item.bad) {
      emit({
        type: 'agent.tool.failed',
        toolCallId: call.id,
        name: call.name,
        ok: false,
        result: '参数不是合法 JSON，无法解析',
      })
      bumpStats({ calls: 1, invalid: 1 })
      return {
        role: 'tool',
        tool_call_id: call.id,
        content: '错误：工具参数不是合法 JSON。请重新调用，arguments 必须是 JSON 字符串。',
      }
    }
    let duplicate = false
    if (options.taskId) {
      try {
        const t = taskCore.get(options.taskId)
        const steps = Array.isArray(t?.steps) ? t.steps.slice(-40) : []
        const sig = scheduler.argsHash(item.name, args)
        duplicate = steps.some(
          (s) =>
            s.ok !== false && s.tool === item.name && scheduler.argsHash(s.tool, s.args) === sig,
        )
      } catch {}
    }
    const duplicateInvalid = duplicate && scheduler.isReadonly(item.name)

    /*
     * P0-3：这次调用的 **Action**（危险度/规模/可逆性/范围）——「一次工具调用一个对象」。
     * 组装只此一处；判据仍来自 risk / scale / task-intent 各自的家，这里只收拢不重判。
     */
    const action = actionCore.of({
      name: call.name,
      args,
      workdir: ctx?.workdir ?? '',
      userText: typeof options?.authorizationText === 'string' ? options.authorizationText : lastUserText(options?.history),
    })
    const retry = retryLink(toolRuns, call, args)
    emit({
      type: 'agent.tool.started',
      toolCallId: call.id,
      name: call.name,
      args,
      parallel,
      action,
      ...retry,
    })
    const startedAt = Date.now()
    const runCtx = buildRunCtx(ctx, { emit, toolCallId: call.id, toolName: call.name })
    runCtx.action = action
    let output = await tools.execute(call.name, args, { ...runCtx, wantMeta: true })
    let autoRetries = 0
    const maxRetries = Number.isFinite(options.budget?.maxRetries)
      ? Math.max(0, options.budget.maxRetries)
      : errors.MAX_AUTO_RETRY
    for (let retry = 0; retry < maxRetries && !isToolOk(output); retry += 1) {
      const retryInfo = errors.classifyToolOutput(outTextOf(output), { name: call.name })
      if (!errors.canAutoRecover(retryInfo, call.name)) break
      autoRetries += 1
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

    /* ★ 统一成文本再往下走（台账/事件/模型消息/观察哨只该看到正文）；
       成败由 isToolOk 一处判，它认结构化里的 toolOk。 */
    const outText = outTextOf(output)
    const ok = isToolOk(output)
    if (ok) doneNames.push(call.name)
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
      ...retry,
      output: outText,
      ms: Date.now() - startedAt,
      parallel: parallel === true,
      facts: toolFailure.factsOf(output),
      ...(failure ? { error: failure } : {}),
    }
    toolRuns.push(run)
    if (options.taskId) {
      try {
        taskCore.addStep(options.taskId, {
          tool: call.name,
          ok,
          summary: outText,
          ms: run.ms,
          args,
          action,
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
    bumpStats({ calls: 1, invalid: duplicateInvalid ? 1 : 0, duplicates: duplicate ? 1 : 0 })

    /*
     * 失败记一笔给观察哨（分类结果直接递过去，它不再分一次）。
     * 只记录、不动 `info` —— 重试 / 提示 / 中止等行为与以前完全一致。
     */
    if (info) {
      observer.record(info.message || outText, {
        source: 'tool',
        location: call.name,
        kind: info.kind,
        needsUser: info.needsUser,
        retryable: info.retryable,
        hint: info.hint,
        raw: outText,
        tool: call.name,
        taskId: options.taskId,
      })
    }
    const learned = experience.afterRun(run, {
      projectId: ctx?.projectId,
      sessionId: ctx?.sessionId,
      workdir: ctx?.workdir,
    })

    emit({
      type: ok ? 'agent.tool.completed' : 'agent.tool.failed',
      toolCallId: call.id,
      name: call.name,
      ok,
      result: outText,
      ms: run.ms,
      parallel: parallel === true,
      ...retry,
      retryAttempt: autoRetries,
      ...(info ? { errorKind: info.kind, errorHint: info.hint } : {}),
      ...(failure ? { error: failure } : {}),
    })
    let content = outText
    let partial = null
    if (info) {
      const bits = [
        `${outText}\n\n[错误分类] ${info.kind} —— ${info.hint}。建议：${errors.STRATEGY_TEXT[info.strategy] ?? info.strategy}`,
      ]
      const check = scheduler.partialResultOf(writeSnap, call)
      if (check && (check.changed || check.created)) {
        partial = check
        bits.push(
          `[部分成功检测] 目标文件${check.created ? '已被创建' : '可能已被部分修改'}（${check.path}）—— 重试前先 read_file 确认现场，不要盲目重来。`,
        )
      }
      if (learned.note) bits.push(learned.note)
      content = bits.join('\n')
      failures.push({
        name: call.name,
        hint: info.hint,
        kind: info.kind,
        target: targetOf(item),
        retryCount: autoRetries,
        partial,
      })
    } else if (duplicateInvalid) {
      content = `${outText}\n\n[重复调用提示] 这次调用与本次任务中已有的一次成功调用完全相同（结果见历史）。目标未变化时不必重复读取。`
    }

    return { role: 'tool', tool_call_id: call.id, content }
  }

  const bumpStats = (delta) => {
    if (!options.taskId) return
    try {
      taskNotes.bumpToolStats(options.taskId, delta)
    } catch {}
  }
  for (const batch of batches) {
    const parallel = batch.length > 1
    if (batch.length === 1) {
      messages.push(await runOne(batch[0], { parallel: false }))
    } else {
      const results = await Promise.all(batch.map((item) => runOne(item, { parallel: true })))
      for (const message of results) messages.push(message)
    }
  }
  if (failures.length > 0) {
    const note = buildFailureNote({ done: doneNames, failed: failures })
    messages.push({ role: 'user', content: note })
    log.info(`失败后继续：已完成 ${doneNames.length} 步，失败 ${failures.length} 步`)
  }
  if (options.taskId) taskStrict.pushStrictNote(messages, options.taskId)
  if (options.taskId && touchedFiles) {
    try {
      taskCore.checkpoint(options.taskId, { label: `第 ${turn + 1} 轮改动完成` })
    } catch {}
    touchedFiles = false
  }

  return { touched: touchedFiles }
}

module.exports = { executeToolCalls }
