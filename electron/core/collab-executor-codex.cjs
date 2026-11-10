/**
 * Codex 工作模型通过已启用的 Harbor MCP 桥执行任务；开发计划另需开放写入。
 * 每次执行拥有独立任务与变更集，桥的实际返回实时形成工具证据；
 * 不从磁盘调用日志拼接结果，不自动扩大授权。失败时保留记录以供续做。
 * 此模块不依赖 Electron，可由主进程编排器独立加载。
 */

const { chatStream } = require('./codex-cli.cjs')
const { buildTask } = require('./collab-task.cjs')

/** MCP 桥现在开着吗（决定 codex 做 B 有没有工具可用） */
function bridgeEnabled() {
  try {
    return require('./codex-mcp-switch.cjs').enabled() === true
  } catch {
    return false
  }
}

/** 同一份通用任务约定，补充 Codex 实际可观察的 MCP 工具入口。 */
function executorPrompt(input) {
  return [
    buildTask(input.goal, input.plan, input.projectRoot, {
      round: input.round,
      previousResult: input.previousResult,
      feedback: input.feedback,
    }),
    input.imageAnalysis
      ? `\n图片识别结果（由已配置的视觉模型读取，不是图片原文）：\n${input.imageAnalysis}`
      : '',
    '使用 Harbor MCP 提供的实际工具结果完成任务；未被 Harbor 记录的动作不能作为验收证据。',
    '可用工具以当前 MCP 列表和权限为准，缺少权限时说明阻塞，不自行绕过：',
    '  · harbor_read_file —— 读取当前对话目录内的文件',
    '  · harbor_read_image —— 读取当前对话已授权范围内的真实图片内容；无视觉模型时只使用已配置的识图模型',
    '  · harbor_search_web —— 使用 Harbor 已配置的搜索服务，沿用本轮联网权限；保留真实结果的来源与时间',
    '  · harbor_edit_file —— 根据文件版本局部编辑（逐次审批）',
    '  · harbor_write_file —— 新建或整体覆盖文件（逐次审批）',
    '  · 没有可用的测试命令工具时，说明未验证，不能声称测试通过',
  ].filter(Boolean).join('\n\n')
}

/**
 * codex 做 B：跑一次执行。
 *
 * @param {{ goal: string, plan: object, projectRoot: string, config: object, sessionId?: string,
 *           phaseKey?: string, provider?: object, imageAnalysis?: string,
 *           origin?: string, allowBuiltinBrowser?: boolean, threadSettings?: object,
 *           round?: number, previousResult?: object|string, feedback?: object|string,
 *           signal?: AbortSignal, confirm?: Function, emit?: Function,
 *           recallEvidence?: Function }} input
 * @returns {Promise<{ content: string, finalContent: string, toolRuns: Array, taskId: string, usage: object|null }>}
 */
async function run(input) {
  if (!bridgeEnabled()) throw new Error('Codex 工作模型需要启用 Harbor MCP 桥')
  if (
    input.plan.kind === 'development' &&
    require('./codex-mcp-switch.cjs').writeConfig().writeEnabled !== true
  )
    throw new Error('Codex 开发任务需要工具桥开放文件写入能力；不会自动扩大你的授权')
  const task = require('./task.cjs')
  const changeset = require('./changeset.cjs')
  const contexts = require('./codex-mcp-context.cjs')
  const constraints = require('./user-constraints.cjs')
  const record = task.create({
    goal: '协作执行：' + input.plan.problem,
    sessionId: input.sessionId,
    workdir: input.projectRoot,
  })
  const change = changeset.begin({
    taskId: record.id,
    sessionId: input.sessionId,
    title: record.title,
  })
  const runId = 'collab_' + require('node:crypto').randomUUID().replace(/-/g, '')
  const toolRuns = []
  const emit = typeof input.emit === 'function' ? input.emit : () => {}
  emit({ type: 'task', taskId: record.id, changeSetId: change.ok ? change.id : '' })
  const onTool = (event) => {
    emit(event)
    const index = toolRuns.findIndex((run) => run.id === event.toolCallId)
    if (event.type === 'agent.tool.started')
      toolRuns.push({
        id: event.toolCallId,
        name: event.name,
        args: event.args,
        pending: true,
        ok: false,
        output: '',
      })
    else if (index >= 0) {
      Object.assign(toolRuns[index], { ok: event.ok === true, output: event.result, ms: event.ms })
      delete toolRuns[index].pending
      if (event.ok && (event.name === 'write_file' || event.name === 'edit_file'))
        task.addChangedFile(record.id, String(toolRuns[index].args?.path ?? ''))
      task.addStep(record.id, {
        tool: event.name,
        ok: event.ok,
        summary: event.result,
        ms: event.ms,
        args: toolRuns[index].args,
        action: null,
        error: null,
      })
    }
  }
  const registered = contexts.register(runId, {
    requestId: input.phaseKey || record.id,
    sessionId: input.sessionId,
    collab: true,
    taskId: record.id,
    changeSetId: change.ok ? change.id : '',
    workdir: input.projectRoot,
    permission: input.config.tools?.permission,
    threadSettings: input.threadSettings,
    allowWrite: constraints.allowsWrite({
      userText: input.goal,
      mode: 'pair',
      threadAllowWrite: input.threadSettings?.allowWrite,
    }),
    allowNetwork: constraints.allowsNetwork({
      userText: input.goal,
      threadAllowNetwork: input.threadSettings?.allowNetwork,
    }),
    signal: input.signal,
    confirm: input.confirm,
    onTool,
    recallEvidence: input.recallEvidence,
    vision: { config: input.config, provider: input.provider, model: 'codex-cli' },
  })
  try {
    if (!registered) throw new Error('当前对话的 Codex 工具授权未成功登记，不能继续执行')
    let finalMessage = ''
    /** @type {any} */
    const result = await chatStream({
      purpose: 'collab',
      messages: [{ role: 'user', content: executorPrompt(input) }],
      model: 'codex-cli',
      provider: input.provider,
      cwd: input.projectRoot,
      signal: input.signal,
      traceId: runId,
      onContent: (text) => {
        finalMessage = String(text)
        emit({ type: 'content', text })
      },
    })
    if (result?.sawDone === false || result?.finishReason === 'length')
      throw new Error('工作模型输出未完整结束，已有改动保留，不能记为完成')
    const content = String(result?.finalContent ?? (finalMessage || result?.content) ?? '')
    if (!content.trim()) throw new Error('工作模型没有返回内容')
    if (change.ok) changeset.commit(change.id, { verified: null })
    task.finish(record.id, { result: content })
    return { content, finalContent: content, toolRuns, taskId: record.id, usage: result.usage }
  } catch (error) {
    task.finish(record.id, { status: 'paused', result: String(error?.message ?? error) })
    task.update(record.id, { pausedAt: Date.now() })
    throw error
  } finally {
    contexts.unregister(runId)
  }
}

module.exports = { run, executorPrompt, bridgeEnabled }
