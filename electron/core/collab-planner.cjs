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
 * 把「这次 A 到底产出了什么、为什么没被采用」写回子任务台账。
 *
 * 只改说明文字，不改状态 —— 该子步骤确实跑完了，只是产出不能当结论。
 * 取不到 taskId（老内核 / 自检里没有台账）时静默跳过，不影响主流程。
 */
function markChildTask(taskId, text) {
  if (!taskId) return
  try {
    require('./task.cjs').update(String(taskId), { result: String(text).slice(0, 800) })
  } catch {
    /* 台账写不进去不该让失败路径再抛一次 */
  }
}

/**
 * 用 loop（只读）跑一次，拿回正文。取消往上抛（上层按 AbortError 处理）。
 * @param {object} input
 */
async function runReadOnly(input) {
  const { prompt, config, model, workdir, signal, confirm, emit } = input
  const loop = require('./loop.cjs')
  /*
   * ★ 规划 / 验收阶段的**正文和思考不往界面推**（2026-10-20 真机逮到）。
   *
   * 这一轮的 `emit` 原本原样交给 loop，于是 A 读文件时那几句自然语言会被当成
   * 「助手正在回答」流式显示出来。用户看到「读完了项目，只有两个文件，没有
   * 可改的代码路径」，很自然地理解成**一轮正常回答**；紧接着 done 把 content
   * 换成 `PLAN_UNPARSABLE` 的原因，界面内容就闪变了。更糟的是失败时那条
   * 后台通知取的是这段正文，于是用户被告知「项目里没东西可改」，而真实原因是
   * 「A 没按格式吐 json 计划」—— 两个完全不同的排查方向。
   *
   * 工具调用痕迹（`agent.tool.*`）和阶段提示（`collab.phase`）照旧放行：
   * 用户要能看见它在干活，只是不该把「草稿」当「回答」。
   */
  const say =
    typeof emit === 'function'
      ? (event) => {
          const type = String(event?.type ?? '')
          if (type === 'content' || type === 'reasoning') return
          emit(event)
        }
      : undefined
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
      emit: say,
      /*
       * ★ 标成「协作子步骤」：`loop-prompt.cjs` 据此不读写会话状态。
       * 否则 A 那句「你是只读规划者，没有写文件的能力」会作为会话 topic 落盘，
       * 被随后执行的 B 读回去 —— B 于是只读不写（2026-10-20 真机逮到）。
       */
      collabSubStep: true,
      threadSettings: { ...input.threadSettings, allowWrite: false, useMemory: false },
    })
    const text = String(result?.content ?? '')
    /*
     * ★ 把**真实原因**写回这条子任务的台账（2026-10-20 真机逮到）。
     *
     * `loop.run` 会把这一轮标成 `completed`、`result` = A 的正文，而
     * `notify.onRunEnd` 取的是「这条会话最近更新的一条任务」——
     * 于是协作失败时，用户收到的通知标题是「后台任务完成」、正文却是
     * 「读完了项目，只有两个文件，没有可改的代码路径」，让他以为项目里
     * 没东西可改。真实原因（比如 PLAN_UNPARSABLE）根本没出现在那条通知里。
     *
     * 这里只改**台账里那行文字**，不伪造状态：A 的这次读取确实跑完了，
     * 只是它的产出不能当结论看 —— 所以把台帐说明改成「这次产出了什么、
     * 为什么没采用」。`ok:false` 由调用方按 code 判定，不依赖这段文字。
     */
    if (!text.trim()) {
      markChildTask(result?.taskId, '指导模型没有返回内容（可能被取消或超时）')
      return failed('PLANNER_EMPTY', '指导模型没有返回内容（可能被取消或超时）')
    }
    return { ok: /** @type {true} */ (true), text, taskId: result?.taskId ?? '' }
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
    markChildTask(res.taskId, `没按格式产出计划（找不到 json 计划块）。模型原话：${String(res.text).slice(0, 400)}`)
    return failed('PLAN_UNPARSABLE', 'A（指导模型）没按要求的 json 格式给出计划，所以没有执行 —— 不是项目里没有可改的东西', { raw: res.text })
  }
  const plan = {
    problem: String(parsed.problem ?? '').trim(),
    scope: codex.cleanList(parsed.scope, 12, 200),
    expected: String(parsed.expected ?? '').trim(),
    verify: String(parsed.verify ?? '').trim(),
  }
  if (!plan.problem || plan.scope.length === 0) {
    markChildTask(res.taskId, `计划缺字段（problem=${plan.problem || '空'}，scope=${plan.scope.length} 项）`)
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
    markChildTask(res.taskId, `验收没按格式产出结论（找不到 json 块）。模型原话：${String(res.text).slice(0, 400)}`)
    return failed('REVIEW_UNPARSABLE', 'A（指导模型）没按要求的 json 格式给出验收结论 —— 不能替它下结论', { raw: res.text })
  }
  const verdict = String(parsed.verdict ?? '').trim().toUpperCase()
  if (!codex.VERDICTS.has(verdict)) {
    markChildTask(res.taskId, `验收结论「${verdict || '(空)'}」不在三选一里`)
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
