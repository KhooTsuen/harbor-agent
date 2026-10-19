/**
 * **A 方（指导模型）用 openai 类后端时的规划 / 验收**（2026-10-17）
 *
 * ── 为什么单独一个文件 ─────────────────────────────────────────
 *
 * `collab-codex.cjs` 走的是 Codex CLI（只读沙箱自己读项目，Harbor 不声明工具）。
 * 当用户把 A 选成 openai 类（DeepSeek 等）时，没有「只读沙箱自己读」这条路 ——
 * openai 类靠 function-calling 读文件。所以这里用 `loop.run` 走**只读**工具链
 * （`read_file` / `list_dir`），拿回正文后再用**同一套** prompt 与 json 解析。
 *
 * ★ 复用 `collab-codex.cjs` 的 `planPrompt` / `reviewPrompt` / `parseJsonBlock` /
 *   `cleanList` —— 形状与解析只定义一处，别在这里再写一份（硬约束 9）。
 *
 * ── 只读是怎么保证的 ──────────────────────────────────────────
 *
 * `threadSettings.allowWrite: false`（与 `subagent.cjs` 同口径）：写工具被拦，
 * `read_file` / `list_dir` 照常。A 角色本就不该写代码 —— 它只读项目、出计划 / 验收。
 *
 * ⚠️ 不 require electron。
 */

const codex = require('./collab-codex.cjs')

/**
 * 构造 config 变体，让 loop 用**指定的模型**（而不是全局默认）。
 * ★ 只改 `assistant.model`；provider 由 `loop-route.cjs` 的 `providerForModel`
 *   按这个模型现查（哪家 provider 的 models 里含它，就用哪家）—— 不硬塞 provider。
 * @param {object} config
 * @param {string} model
 * @returns {object}
 */
function withModel(config, model, providerId = '') {
  const m = String(model ?? '').trim()
  if (!m) return config
  const provider = providerId
    ? (config.providers ?? []).find((item) => item.id === providerId && item.enabled !== false)
    : require('./config.cjs').providerForModel(m, config)
  if (providerId && (!provider || !(provider.models ?? []).includes(m)))
    throw new Error('所选指导/工作模型与供应商配置不匹配，请重新选择')
  return { ...config, _collabProviderId: provider?.id ?? '', assistant: { ...(config.assistant ?? {}), model: m },
    router: { ...(config.router ?? {}), enabled: false },
    ...(provider ? { activeProvider: provider } : {}) }
}

/** 失败结果的统一形状（与 collab-codex 的 failed 同形，避免调用方判三种写法） */
function failed(code, message, extra = {}) {
  return { ok: /** @type {false} */ (false), code: String(code), message: String(message), ...extra }
}

/**
 * 用 loop（只读）跑一次，拿回正文。取消往上抛（上层按 AbortError 处理）。
 * @param {object} input
 */
async function runReadOnly(input) {
  const { prompt, config, model, workdir, signal, confirm, emit } = input
  const loop = require('./loop.cjs')
  try {
    const result = await loop.run({
      goal: '协作（指导模型）',
      history: [{
        role: 'user',
        content: require('./collab-images.cjs').contentWithImages(
          [prompt, input.imageAnalysis].filter(Boolean).join('\n\n'),
          input.images,
        ),
      }],
      config: withModel(config, model, input.providerId),
      workdir,
      sessionId: input.sessionId ?? '',
      mode: 'pair',
      signal: signal ?? new AbortController().signal,
      confirm,
      emit,
      threadSettings: { ...input.threadSettings, allowWrite: false, useMemory: false },
    })
    const text = String(result?.content ?? '')
    if (!text.trim()) return failed('PLANNER_EMPTY', '指导模型没有返回内容（可能被取消或超时）')
    return { ok: /** @type {true} */ (true), text }
  } catch (error) {
    if (error && error.name === 'AbortError') throw error
    return failed('PLANNER_FAILED', String((error && error.message) || error))
  }
}

/**
 * openai 版计划阶段。
 * @param {{ goal: string, projectRoot: string, testCommand?: string, config: object,
 *           model?: string, providerId?: string, sessionId?: string, threadSettings?: object,
 *           images?: string[], imageAnalysis?: string,
 *           signal?: AbortSignal, confirm?: Function, emit?: Function }} input
 */
async function planProjects(input) {
  const prompt = codex.planPrompt(input)
  const res = await runReadOnly({ ...input, prompt, workdir: input.projectRoot })
  if (res.ok !== true) return res

  const parsed = codex.parseJsonBlock(res.text)
  if (!parsed) {
    return failed('PLAN_UNPARSABLE', '指导模型的计划里找不到可解析的 json 块 —— 不猜它的意思', { raw: res.text })
  }
  const plan = {
    problem: String(parsed.problem ?? '').trim(),
    scope: codex.cleanList(parsed.scope, 12, 200),
    expected: String(parsed.expected ?? '').trim(),
    verify: String(parsed.verify ?? '').trim(),
  }
  if (!plan.problem || plan.scope.length === 0) {
    return failed('PLAN_INCOMPLETE', '计划缺少 problem 或 scope —— 执行者无从下手', { raw: res.text, plan })
  }
  return { ok: /** @type {true} */ (true), plan, raw: res.text, fields: codex.PLAN_FIELDS }
}

/**
 * openai 版验收阶段。
 * @param {{ goal: string, plan: object, writes: string[], testStatus: string, testId: string,
 *           diffText?: string, execSummary?: string, config: object, model?: string,
 *           providerId?: string, sessionId?: string, threadSettings?: object,
 *           images?: string[], imageAnalysis?: string,
 *           cwd: string, signal?: AbortSignal, confirm?: Function, emit?: Function }} input
 */
async function reviewResult(input) {
  const prompt = codex.reviewPrompt(input)
  const res = await runReadOnly({ ...input, prompt, workdir: input.cwd })
  if (res.ok !== true) return res

  const parsed = codex.parseJsonBlock(res.text)
  if (!parsed) {
    return failed('REVIEW_UNPARSABLE', '指导模型的验收里找不到可解析的 json 块 —— 不替它下结论', { raw: res.text })
  }
  const verdict = String(parsed.verdict ?? '').trim().toUpperCase()
  if (!codex.VERDICTS.has(verdict)) {
    return failed('REVIEW_BAD_VERDICT', `验收结论「${verdict || '(空)'}」不在 PASS / NEEDS_CHANGES / BLOCKED 里`, { raw: res.text })
  }
  return {
    ok: /** @type {true} */ (true),
    review: {
      verdict,
      reasons: codex.cleanList(parsed.reasons, 12, 400),
      issues: codex.cleanList(parsed.issues, 12, 400),
    },
    raw: res.text,
  }
}

module.exports = { planProjects, reviewResult, withModel }
