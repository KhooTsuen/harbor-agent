/**
 * 工具执行器（token 优化 · 阶段 2；从 loop-tools.cjs 演进）
 *
 * 与旧版的差别：**并行**（连续/只读/目标不同才并发，见 tool-scheduler.cjs）·
 * **部分成功检测**（写失败时比前后 hash，先提醒看现场）· **结构化失败摘要**
 * （error_kind / 目标 / retry_count 进「失败后继续」提示）· **调用统计**进台账 ·
 * **自我纠错**（每次调用的成败喂给 `experience-loop`，候选绝不进提示）。
 * 事件与消息顺序纪律：事件带 toolCallId；tool 消息按**原始调用顺序**入队。
 */

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
/* 成败判定 + 失败事实：形状与判据都只定义在 tool-failure.cjs */
const { isToolOk, outTextOf } = toolFailure

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 失败项的目标（给失败摘要用）：文件路径优先，命令取前 80 字 */
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
  /* AG-017：本轮的成败名单 —— 结尾要拿它给模型一句「进度对照」 */
  const doneNames = []
  const failures = []

  /* ① 一次解析参数（批次规划与快照都要用） */
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

  /* ② 写操作前后快照（部分成功检测的底） */
  const writeSnap = scheduler.snapshotTargets(items, {
    resolve: (p) => {
      try {
        return shared.resolvePath(p, ctx.workdir, ctx)
      } catch {
        return p
      }
    },
  })

  /* ③ 批次规划：连续只读且目标不同 → 一批并行；其余逐个串行 */
  const batches = scheduler.planBatches(items)

  /** 跑一条调用 → 返回要入队的 tool 消息内容；abort 时补一条「没跑」 */
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
      emit({ type: 'agent.tool.failed', toolCallId: call.id, name: call.name, ok: false, result: '参数不是合法 JSON，无法解析' })
      bumpStats({ calls: 1, invalid: 1 })
      return {
        role: 'tool',
        tool_call_id: call.id,
        content: '错误：工具参数不是合法 JSON。请重新调用，arguments 必须是 JSON 字符串。',
      }
    }

    /* 重复调用检测：同任务里「同名同参且成功过」再看一次 —— 只读且没换目标的才算无效 */
    let duplicate = false
    if (options.taskId) {
      try {
        const t = taskCore.get(options.taskId)
        const steps = Array.isArray(t?.steps) ? t.steps.slice(-40) : []
        const sig = scheduler.argsHash(item.name, args)
        duplicate = steps.some(
          (s) => s.ok !== false && s.tool === item.name && scheduler.argsHash(s.tool, s.args) === sig,
        )
      } catch {
        /* 查不到就不算 */
      }
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
      userText: lastUserText(options?.history),
    })
    emit({ type: 'agent.tool.started', toolCallId: call.id, name: call.name, args, parallel, action })
    const startedAt = Date.now()

    /* 这次调用专用的 ctx：`progress` + `subagentEmit`，都贴上 call.id（见 tool-run-ctx.cjs） */
    const runCtx = buildRunCtx(ctx, { emit, toolCallId: call.id, toolName: call.name })
    /* P0-3 步骤 4：把这次调用的 Action 一并交给执行层 —— 各 gate 把权限结论回填到它上面 */
    runCtx.action = action

    /* AG-016：失败后自动恢复（只读工具才自动重试 —— 见 errors.canAutoRecover） */
    let output = await tools.execute(call.name, args, { ...runCtx, wantMeta: true })
    let autoRetries = 0
    const maxRetries = Number.isFinite(options.budget?.maxRetries)
      ? Math.max(0, options.budget.maxRetries)
      : errors.MAX_AUTO_RETRY
    for (let retry = 0; retry < maxRetries && !isToolOk(output); retry += 1) {
      const retryInfo = errors.classifyToolOutput(outTextOf(output), { name: call.name })
      if (!errors.canAutoRecover(retryInfo, call.name)) break
      autoRetries += 1
      emit({ type: 'agent.retrying', toolCallId: call.id, name: call.name, attempt: retry + 1, kind: retryInfo.kind, hint: retryInfo.hint })
      await sleep(errors.backoffMs(retry, retryInfo.kind))
      output = await tools.execute(call.name, args, { ...runCtx, wantMeta: true })
    }

    /* ★ 统一成文本再往下走（台账/事件/模型消息/观察哨只该看到正文）；
       成败由 isToolOk 一处判，它认结构化里的 toolOk。 */
    const outText = outTextOf(output)
    const ok = isToolOk(output)
    if (ok) doneNames.push(call.name)
    /* 失败事实（形状只定义在 tool-failure.cjs）—— 事件 / 记录 / 台账读同一份 */
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
      output: outText,
      ms: Date.now() - startedAt,
      parallel: parallel === true,
      /* 结构化事实（退出码 / 超时 / 中断）：独立验证器读它，不读正文 */
      facts: toolFailure.factsOf(output),
      ...(failure ? { error: failure } : {}),
    }
    toolRuns.push(run)

    /* ── 任务台账：这一步干了什么 ── */
    if (options.taskId) {
      try {
        taskCore.addStep(options.taskId, { tool: call.name, ok, summary: outText, ms: run.ms, args, action, error: failure })
        if (call.name === 'run_shell' && typeof args.command === 'string') {
          taskCore.addCommand(options.taskId, args.command, outText)
        }
        if (typeof args.path === 'string' && (call.name === 'write_file' || call.name === 'edit_file')) {
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

    /* 自我纠错：判据全在 experience-loop（候选不进提示、只有验过的才被提、绝不抛）；workdir 给独立验证器用 */
    const learned = experience.afterRun(run, { projectId: ctx?.projectId, sessionId: ctx?.sessionId, workdir: ctx?.workdir })

    emit({
      type: ok ? 'agent.tool.completed' : 'agent.tool.failed',
      toolCallId: call.id,
      name: call.name,
      ok,
      result: outText,
      ms: run.ms,
      parallel: parallel === true,
      ...(info ? { errorKind: info.kind, errorHint: info.hint } : {}),
      ...(failure ? { error: failure } : {}),
    })

    /* 失败时附分类与建议；写操作再附「部分成功检测」 */
    let content = outText
    let partial = null
    if (info) {
      const bits = [`${outText}\n\n[错误分类] ${info.kind} —— ${info.hint}。建议：${errors.STRATEGY_TEXT[info.strategy] ?? info.strategy}`]
      const check = scheduler.partialResultOf(writeSnap, call)
      if (check && (check.changed || check.created)) {
        partial = check
        bits.push(
          `[部分成功检测] 目标文件${check.created ? '已被创建' : '可能已被部分修改'}（${check.path}）—— 重试前先 read_file 确认现场，不要盲目重来。`,
        )
      }
      /* 验证过的经验才在这里出现（候选不进提示）—— 见 experience-loop.afterRun */
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
    } catch {
      /* 统计写不进不影响执行 */
    }
  }

  /* ④ 执行：批内并行、批间串行；消息按**原始顺序**入队 */
  for (const batch of batches) {
    const parallel = batch.length > 1
    if (batch.length === 1) {
      messages.push(await runOne(batch[0], { parallel: false }))
    } else {
      const results = await Promise.all(batch.map((item) => runOne(item, { parallel: true })))
      for (const message of results) messages.push(message)
    }
  }

  /* AG-017：本轮有失败 → 给模型一句「什么成了、什么败了」（历史会被压缩，台账不受影响） */
  if (failures.length > 0) {
    const note = buildFailureNote({ done: doneNames, failed: failures })
    messages.push({ role: 'user', content: note })
    log.info(`失败后继续：已完成 ${doneNames.length} 步，失败 ${failures.length} 步`)
  }

  /* CE-008 严格模式中途门禁：累计写操作 / 勾计划后未验证 → 顶回（判据与话术见 task-strict.cjs） */
  if (options.taskId) taskStrict.pushStrictNote(messages, options.taskId)

  /* 这一轮真动过文件 → 打一个检查点（崩了从这里恢复） */
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
