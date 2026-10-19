/**
 * **B 方（工作模型）用 codex-cli 时的执行**（2026-10-17）
 *
 * ── 为什么单独一个文件 ─────────────────────────────────────────
 *
 * openai 做 B 走 `loop.run`（function-calling 驱动 Harbor 工具）。
 * codex-cli 做 B 没有 function-calling（`codex-cli.cjs` 文件头 ①：toolCalls 恒 []），
 * 它通过 **MCP 桥**调 Harbor 工具（`codex-mcp-bridge.cjs`），而 MCP 桥的
 * `harbor_run_project_test` / `harbor_apply_test_fix` 已经走「授权项目根」
 * （3C-2 的 `project-roots.cjs`）—— 所以 codex 能在用户授权的项目里改代码、跑测试。
 *
 * ── ★ 前提：MCP 桥必须启用 ─────────────────────────────────────
 *
 * 不启用（`HARBOR_CODEX_MCP` 未设、`config.codexMcp.enabled` 为 false）时，
 * codex 没有任何可调的工具 —— 只能读、不能说改。这里**如实报错**，不静默降级。
 *
 * ── trace 从哪来 ──────────────────────────────────────────────
 *
 * codex 不产 tool_call 给 Harbor，所以没有 `toolRuns`。改为：给 MCP 桥的调用记录
 * 补上 `runId`（见 codex-mcp-bridge.cjs 的 recordCall），执行前记下 runId，执行后
 * 从 `codex-mcp-calls.jsonl` 按 runId 抽真实调用记录，转成 trace 需要的形状。
 *
 * ⚠️ 不 require electron。
 */

const { chatStream } = require('./codex-cli.cjs')

/** 失败结果的统一形状 */
function failed(code, message, extra = {}) {
  return {
    ok: /** @type {false} */ (false),
    code: String(code),
    message: String(message),
    ...extra,
  }
}

/** MCP 桥现在开着吗（决定 codex 做 B 有没有工具可用） */
function bridgeEnabled() {
  try {
    return require('./codex-mcp-switch.cjs').enabled() === true
  } catch {
    return false
  }
}

/**
 * 执行阶段的提示词：告诉 codex 它是**执行者**，有 MCP 工具可调，怎么用。
 * 计划原样给到，明确「只改这些」。
 */
function executorPrompt(input) {
  const { goal, plan, projectRoot } = input
  return [
    '你是这次开发的**执行者**（工作模型）。规划者已经给出下面的计划，你负责把它做完。',
    '',
    `项目根：${projectRoot}`,
    input.imageAnalysis ? `\n图片识别结果（由已配置的视觉模型读取，不是图片原文）：\n${input.imageAnalysis}` : '',
    '',
    '你可以通过 MCP 工具做这些事（每次写操作都会弹给用户审批，可能被拒绝）：',
    '  · harbor_read_file —— 读取当前对话目录内的文件',
    '  · harbor_read_image —— 读取当前对话已授权范围内的真实图片内容；无视觉模型时只使用已配置的识图模型',
    '  · harbor_edit_file —— 根据文件版本局部编辑（逐次审批）',
    '  · harbor_write_file —— 新建或整体覆盖文件（逐次审批）',
    '  · 没有可用的测试命令工具时，说明未验证，不能声称测试通过',
    '',
    '要解决的问题：',
    plan.problem,
    '',
    '允许修改的文件（**只改这些**，别扩大范围）：',
    ...(plan.scope.length > 0 ? plan.scope.map((s) => `  · ${s}`) : ['  （计划未指定）']),
    '',
    `预期结果：${plan.expected || '（计划未声明）'}`,
    `验证方法：${plan.verify || '（计划未声明）'}`,
    '',
    '用户原话：',
    goal,
    '',
    '最后用一句话汇报你改了什么、测试结果如何。',
  ].join('\n')
}

/**
 * codex 做 B：跑一次执行。
 *
 * @param {{ goal: string, plan: object, projectRoot: string, config: object, sessionId?: string,
 *           phaseKey?: string, provider?: object, imageAnalysis?: string,
 *           signal?: AbortSignal, confirm?: Function, emit?: Function }} input
 * @returns {Promise<{ content: string, toolRuns: Array }>}
 */
async function run(input) {
  const { goal, plan, projectRoot, signal } = input

  if (!bridgeEnabled()) {
    throw new Error('Codex 作为工作模型需要启用 Codex MCP 桥；启用后沿用当前对话目录与授权')
  }

  const runId = String(input.phaseKey ?? '')
  if (!require('./codex-mcp-context.cjs').get(runId)?.collab) {
    throw new Error('当前对话的 Codex 工具授权已失效，无法继续执行')
  }

  const res = await chatStream({
    messages: [{ role: 'user', content: executorPrompt({ goal, plan, projectRoot }) }],
    model: 'codex-cli',
    provider: input.provider ?? { kind: 'codex-cli', codexPath: '' },
    cwd: projectRoot,
    signal,
    traceId: runId,
  })

  const content = String(res?.content ?? '')
  if (!content.trim()) throw new Error('Codex（工作模型）没有返回内容')

  /* 从 MCP 调用记录抽真实痕迹（codex 不产 toolRuns，只能从这里还原） */
  const toolRuns = require('./collab-trace-codex.cjs').fromCalls(runId)
  return { content, toolRuns }
}

module.exports = { run, executorPrompt, bridgeEnabled }
