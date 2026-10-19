/**
 * **A 方（Codex CLI）的两次调用**：`planProjects`（检查 + 规划）与 `reviewResult`（验收）
 *
 * ── ★ 它为什么改不了用户的文件 ────────────────────────────────
 *
 * 底层 `codex-run.cjs` 的沙箱是**写死的 `-s read-only`**（常量，不做成配置项）。
 * 所以 Codex 能读项目、能思考、能规划 —— 但**没有写盘能力**。
 * 要改代码只能由 DeepSeek 走 Harbor 的工具链（有审批 + 审计 + 恢复点）。
 * 这是「Codex 不能绕过权限系统」在**代码层**的落实，不是靠提示词约束。
 *
 * ── ★ 计划与验收都是**结构化**的，解析失败就如实报 ──────────────
 *
 * 模型输出是文字。这里要求它给一个 ```json 块，然后严格解析：
 * 字段缺了 / 枚举值不认识 → 返回 `unparsable`，把原文带回去给用户看。
 * **绝不从自然语言里猜**「它大概是 PASS 吧」—— 那是把验收变成许愿。
 *
 * ⚠️ 不 require electron。
 */

const { chatStream } = require('./codex-cli.cjs')

/** 一个 JSON 块最多多大（防模型吐一大坨把内存/界面撑爆） */
const MAX_JSON_CHARS = 20_000

/** 计划里允许的字段（多的一律丢掉 —— 形状只有一处） */
const PLAN_FIELDS = ['problem', 'scope', 'expected', 'verify']

/**
 * 从模型输出里抠出**唯一**一个 JSON 对象。
 *
 * 先找 ```json 围栏，再退化到「第一个 { 到最后一个 }」。
 * 两种都失败 → null（调用方据此判 unparsable，不去猜）。
 *
 * @param {string} text
 * @returns {object|null}
 */
function parseJsonBlock(text) {
  const src = String(text ?? '')
  if (!src.trim()) return null

  const fenced = src.match(/```(?:json)?\s*\n([\s\S]*?)```/i)
  const candidates = []
  if (fenced && fenced[1]) candidates.push(fenced[1])
  const first = src.indexOf('{')
  const last = src.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(src.slice(first, last + 1))

  for (const raw of candidates) {
    const body = raw.trim()
    if (!body || body.length > MAX_JSON_CHARS) continue
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* 试下一个候选 */
    }
  }
  return null
}

/** 把任意值收成「短字符串数组」（去空、去重、限量） */
function cleanList(value, max = 12, maxLen = 300) {
  const arr = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const out = []
  for (const one of arr) {
    const text = typeof one === 'string' ? one.trim() : String(one ?? '').trim()
    if (!text) continue
    const item = text.slice(0, maxLen)
    if (!out.includes(item)) out.push(item)
    if (out.length >= max) break
  }
  return out
}

/**
 * @param {string} code
 * @param {string} message
 * @param {{ raw?: string, plan?: any }} [extra]
 */
function failed(code, message, extra = {}) {
  return { ok: /** @type {false} */ (false), code: String(code), message: String(message), ...extra }
}

/**
 * 一次 Codex 调用的结果。
 * @typedef {{ ok: true, text: string } | { ok: false, code: string, message: string, raw?: string }} CallResult
 */

/**
 * 计划阶段的提示词。
 *
 * ★ 三条信息必须同时给到，否则 Codex 会"礼貌地瞎猜"：
 *   ① 它的角色是只读的规划者（写不了文件）
 *   ② 项目根在哪、用户的原始目标是什么
 *   ③ 输出必须是一个 json 块，字段名固定
 */
function planPrompt(input) {
  const { goal, projectRoot, testCommand } = input
  return [
    '你是这次开发的**规划者**（只读角色）。你**没有写文件的能力**，也不要声称自己改过任何东西。',
    '你的产出会被交给另一个执行者（它有文件读写与跑测试的能力，且每次写入都要用户审批）。',
    '',
    `项目根：${projectRoot}`,
    testCommand ? `项目里已授权的测试命令：${testCommand}` : '项目里暂时没有配置测试命令。',
    '',
    '用户的目标：',
    goal,
    input.imageAnalysis ? `\n图片识别结果（由已配置的视觉模型读取，不是图片原文）：\n${input.imageAnalysis}` : '',
    '',
    '请先**真的读**这个项目里与目标相关的文件（你可以读，不能写），然后给出一个可执行的开发任务。',
    '',
    '输出要求：正文可以写你的分析；**最后必须给一个 json 块**，字段固定为：',
    '```json',
    '{',
    '  "problem": "要解决的问题（一句话，具体）",',
    '  "scope": ["允许修改的文件（相对项目根的路径，尽量少）"],',
    '  "expected": "改完之后应该是什么样（可观察的结果）",',
    '  "verify": "怎么验证（用上面那条测试命令，还是别的观察）"',
    '}',
    '```',
    '不要输出别的 json 块。',
  ].join('\n')
}

/**
 * 验收阶段的提示词。
 *
 * ★ 给的是**真实执行痕迹**：改了哪些文件、diff、测试六态、执行 id。
 *   不给这些，验收就退化成「信任执行者自述」。
 */
function reviewPrompt(input) {
  const { goal, plan, writes, testStatus, testId, diffText, execSummary } = input
  const lines = [
    '你是这次开发的**验收者**（只读角色）。你**没有写文件的能力**。',
    '下面是执行者真实做过的事，以及 Harbor 记录到的真实状态。请**独立**判断它是否达成了目标。',
    '',
    `原始目标：${goal}`,
    '',
    '规划阶段确定的范围：',
    ...(Array.isArray(plan?.scope) && plan.scope.length > 0
      ? plan.scope.map((s) => `  · ${s}`)
      : ['  （未声明）']),
    `预期结果：${plan?.expected ?? '（未声明）'}`,
    '',
    `执行者实际改动的文件：${writes.length > 0 ? writes.join(' / ') : '（没有改动任何文件）'}`,
    `测试条目：${testId || '（无）'}　真实状态：${testStatus || '（没有跑测试）'}`,
  ]
  if (diffText) lines.push('', '实际差异：', '```diff', diffText.slice(0, 8000), '```')
  if (execSummary) lines.push('', '执行摘要（执行者原话）：', execSummary.slice(0, 4000))
  lines.push(
    '',
    '判断口径：',
    '  · PASS —— 目标达成，且测试真实通过（没有测试就说明证据不足，不要给 PASS）',
    '  · NEEDS_CHANGES —— 改动方向对但没做完 / 测试没过 / 改到了范围外的文件',
    '  · BLOCKED —— 因为权限、测试不可用、环境问题而无法完成',
    '',
    '输出要求：正文写你的判断依据；**最后必须给一个 json 块**：',
    '```json',
    '{',
    '  "verdict": "PASS | NEEDS_CHANGES | BLOCKED",',
    '  "reasons": ["判断依据（对着真实状态说，别复述执行者的话）"],',
    '  "issues": ["需要修的具体问题（没有就空数组）"]',
    '}',
    '```',
    '不要输出别的 json 块。',
  )
  return lines.join('\n')
}

/**
 * 调一次 Codex（只读沙箱），拿回正文。
 * @returns {Promise<CallResult>}
 */
async function callCodex(prompt, options) {
  const { cwd, signal, provider } = options
  try {
    const res = await chatStream({
      /* 拍平用：只给一条 user 消息，prompt 已经是完整指令 */
      messages: [{ role: 'user', content: prompt }],
      model: 'codex-cli',
      provider: provider ?? { kind: 'codex-cli', codexPath: '' },
      cwd,
      signal,
      /* ★ 不传 tools：让 codex 用自己的只读能力读项目，Harbor 不声明"有工具" */
    })
    const text = String(res?.content ?? '')
    if (!text.trim()) return failed('CODEX_EMPTY', 'Codex 没有返回内容（可能未登录 / 网络不通）')
    return { ok: true, text }
  } catch (error) {
    /* 取消要往上抛（上层按 AbortError 处理），其余如实转述 */
    if (error && error.name === 'AbortError') throw error
    return failed('CODEX_FAILED', String((error && error.message) || error))
  }
}

/**
 * 计划阶段。**成功 = 拿到形状完整的计划**；解析不出来就如实失败。
 *
 * @param {{ goal: string, projectRoot: string, testCommand?: string, imageAnalysis?: string,
 *           cwd: string, signal?: AbortSignal, provider?: object }} input
 */
async function planProjects(input) {
  const prompt = planPrompt(input)
  const res = await callCodex(prompt, input)
  if (res.ok !== true) return res

  const parsed = parseJsonBlock(res.text)
  if (!parsed) {
    return failed('PLAN_UNPARSABLE', 'Codex 的计划里找不到可解析的 json 块 —— 不猜它的意思', {
      raw: res.text,
    })
  }
  const plan = {
    problem: String(parsed.problem ?? '').trim(),
    scope: cleanList(parsed.scope, 12, 200),
    expected: String(parsed.expected ?? '').trim(),
    verify: String(parsed.verify ?? '').trim(),
  }
  /* 关键字段空着就当没规划出来：执行者拿不到"改哪里"，继续下去只会瞎改 */
  if (!plan.problem || plan.scope.length === 0) {
    return failed('PLAN_INCOMPLETE', '计划缺少 problem 或 scope —— 执行者无从下手', {
      raw: res.text,
      plan,
    })
  }
  return { ok: /** @type {true} */ (true), plan, raw: res.text, fields: PLAN_FIELDS }
}

/** 验收结论的合法取值（**只认这三个**，别的一律当解析失败） */
const VERDICTS = new Set(['PASS', 'NEEDS_CHANGES', 'BLOCKED'])

/**
 * 验收阶段。
 *
 * @param {{ goal: string, plan: object, writes: string[], testStatus: string, testId: string,
 *           diffText?: string, execSummary?: string, cwd: string,
 *           signal?: AbortSignal, provider?: object }} input
 */
async function reviewResult(input) {
  const prompt = reviewPrompt(input)
  const res = await callCodex(prompt, input)
  if (res.ok !== true) return res

  const parsed = parseJsonBlock(res.text)
  if (!parsed) {
    return failed('REVIEW_UNPARSABLE', 'Codex 的验收里找不到可解析的 json 块 —— 不替它下结论', {
      raw: res.text,
    })
  }
  const verdict = String(parsed.verdict ?? '')
    .trim()
    .toUpperCase()
  if (!VERDICTS.has(verdict)) {
    return failed(
      'REVIEW_BAD_VERDICT',
      `验收结论「${verdict || '(空)'}」不在 PASS / NEEDS_CHANGES / BLOCKED 里`,
      {
        raw: res.text,
      },
    )
  }
  return {
    ok: /** @type {true} */ (true),
    review: {
      verdict,
      reasons: cleanList(parsed.reasons, 12, 400),
      issues: cleanList(parsed.issues, 12, 400),
    },
    raw: res.text,
  }
}

module.exports = {
  PLAN_FIELDS,
  VERDICTS,
  parseJsonBlock,
  cleanList,
  planPrompt,
  reviewPrompt,
  planProjects,
  reviewResult,
}
