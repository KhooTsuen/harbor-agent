/**
 * 工具执行器（token 优化 · 阶段 2；从 loop-tools.cjs 演进）
 *
 * 与旧版的差别：
 *   · **并行**：同一轮里「连续、只读、目标不同」的调用合成一批并发跑
 *     （写入 / 同目标 / 有依赖的一律串行 —— 计划见 tool-scheduler.cjs）；
 *   · **部分成功检测**：写文件失败时对比目标文件前后的 hash —— 被改过就先提醒
 *     「重试前看现场」，不许盲目重放（§六）；
 *   · **结构化失败摘要**：error_kind / 目标 / retry_count 进「失败后继续」提示（不再只给名字）；
 *   · **调用统计**：calls / invalid / duplicates / cacheHits 进任务台账（无效调用率的分子）。
 *
 * 事件与消息顺序纪律：
 *   · 事件带 toolCallId（并行时靠它稳定映射）；
 *   · tool 消息按**原始调用顺序**入队（协议稳妥，历史可读）。
 */

const log = require('./log.cjs')
const tools = require('./tools/index.cjs')
const taskCore = require('./task.cjs')
const taskNotes = require('./task-notes.cjs')
const errors = require('./errors.cjs')
const scheduler = require('./tool-scheduler.cjs')
const shared = require('./tools/_shared.cjs')
const { buildFailureNote } = require('./loop-prompt.cjs')
const { isAborted } = require('./abort.cjs')

/** 工具返回算不算成功 —— 全项目只有这一处判定 */
function isToolOk(output) {
  const text = String(output ?? '')
  return !text.startsWith('错误：') && !text.startsWith('用户拒绝了')
}

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

    /* 重复调用检测（无效调用率分子）：
       同任务里「同名同参且成功过」再看一次 —— 只读且没换目标的才算无效 */
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

    emit({ type: 'agent.tool.started', toolCallId: call.id, name: call.name, args, parallel })
    const startedAt = Date.now()

    /*
     * AG-016：失败后自动恢复（只读工具才自动重试 —— 理由见 errors.canAutoRecover）。
     */
    let output = await tools.execute(call.name, args, ctx)
    let autoRetries = 0
    const maxRetries = Number.isFinite(options.budget?.maxRetries)
      ? Math.max(0, options.budget.maxRetries)
      : errors.MAX_AUTO_RETRY
    for (let retry = 0; retry < maxRetries && !isToolOk(output); retry += 1) {
      const retryInfo = errors.classifyToolOutput(output, { name: call.name })
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
      output = await tools.execute(call.name, args, ctx)
    }

    const ok = isToolOk(output)
    if (ok) doneNames.push(call.name)
    const run = { id: call.id, name: call.name, args, ok, output, ms: Date.now() - startedAt, parallel: parallel === true }
    toolRuns.push(run)

    /* ── 任务台账：这一步干了什么 ── */
    if (options.taskId) {
      try {
        taskCore.addStep(options.taskId, { tool: call.name, ok, summary: output, ms: run.ms, args })
        if (call.name === 'run_shell' && typeof args.command === 'string') {
          taskCore.addCommand(options.taskId, args.command, output)
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

    const info = ok ? null : errors.classifyToolOutput(output, { name: call.name })

    emit({
      type: ok ? 'agent.tool.completed' : 'agent.tool.failed',
      toolCallId: call.id,
      name: call.name,
      ok,
      result: output,
      ms: run.ms,
      parallel: parallel === true,
      ...(info ? { errorKind: info.kind, errorHint: info.hint } : {}),
    })

    /* 失败时附分类与建议；写操作再附「部分成功检测」 */
    let content = output
    let partial = null
    if (info) {
      const bits = [`${output}\n\n[错误分类] ${info.kind} —— ${info.hint}。建议：${errors.STRATEGY_TEXT[info.strategy] ?? info.strategy}`]
      const check = scheduler.partialResultOf(writeSnap, call)
      if (check && (check.changed || check.created)) {
        partial = check
        bits.push(
          `[部分成功检测] 目标文件${check.created ? '已被创建' : '可能已被部分修改'}（${check.path}）—— 重试前先 read_file 确认现场，不要盲目重来。`,
        )
      }
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
      content = `${output}\n\n[重复调用提示] 这次调用与本次任务中已有的一次成功调用完全相同（结果见历史）。目标未变化时不必重复读取。`
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

  /*
   * AG-017：本轮有失败 → 给模型一句「什么成了、什么败了」。
   * 历史会被压缩（AG-016）：压完之后早期步骤只剩摘要 —— 台账不受影响，在这再说一遍。
   */
  if (failures.length > 0) {
    const note = buildFailureNote({ done: doneNames, failed: failures })
    messages.push({ role: 'user', content: note })
    log.info(`失败后继续：已完成 ${doneNames.length} 步，失败 ${failures.length} 步`)
  }

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
