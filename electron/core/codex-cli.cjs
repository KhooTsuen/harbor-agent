/**
 * **codex-cli 后端适配器** —— 与 `llm.chatStream` **同形**
 *
 * 推理走本机已登录的 ChatGPT Codex CLI（`codex exec --json`），**不是** HTTP API。
 * 所以这个文件是「第二种后端种类」的入口（`provider.kind === 'codex-cli'`）。
 *
 * ── ★ 同形契约（复用的全部意义）───────────────────────────────
 *
 *   入参：与 `llm.chatStream` 一致（messages / tools / signal / onContent / …）
 *   返回：`{ content, reasoning, toolCalls, usage, finishReason, ttftMs, latencyMs }`
 * 于是 `loop-model.cjs` 只需在调用前分流**一行**，循环 / 工具 / 审批 / 预算 / 恢复
 * 全都不感知这次分流（设计 §3）。
 *
 * ── ★★ 三条如实声明（不伪装成完整兼容 · 用户第 3、9 条）────────
 *
 *   ① **`toolCalls` 恒为 `[]`，且不调 `onToolCalls`** —— 实测 codex 的 JSONL
 *      **没有 `tool_call` 事件**（设计 §2 事实 2）。它自带 agent loop、不对外暴露
 *      function-calling。所以 Harbor 的工具在这条后端上**不可用**，如实为空。
 *   ② **流式是 item 级**：一次 `agent_message` 整段到，`onContent` 就整段给一次
 *      （声明里 `streaming: false`，别骗界面说逐字）。
 *   ③ **`reasoning` 恒为 `''`**：codex 只报 reasoning 的 **token 数**，没有正文流。
 *
 * ── 谁在用哪些参数 ────────────────────────────────────────────
 *
 * 用到：`messages`（拍平）· `tools`（只用来决定要不要写「没有工具」那句）·
 *       `signal`（取消）· `provider.codexPath`（启动器）· `onContent` / `onUsage`。
 * **刻意忽略**：`baseUrl` / `apiKey` / `chatPath`（走 CLI 不走 HTTP）·
 *       `temperature` / `topP` / `maxTokens`（codex 不接这些）·
 *       `idleTimeoutMs`（**那是 HTTP 路径的 45 秒**，在这条路上会把慢启动误杀 ——
 *       改用 codex 自己的宽超时，见 codex-run.cjs）。
 *
 * 设计全文见 `docs/research/codex-cli-adapter-design.md`。
 * ⚠️ 本模块**不 require electron**（自检要能在纯 Node 里直接跑）。
 */

const { buildPrompt } = require('./codex-msg.cjs')
const { newState, applyEvent } = require('./codex-jsonl.cjs')
const { runCodex, resolveLauncher, DEFAULT_IDLE_MS, DEFAULT_TOTAL_MS } = require('./codex-run.cjs')

/** codex 事件 → Harbor 终止原因。它只报「turn 完成」，没有 length 那种截断信号 */
function finishReasonOf(state) {
  return state.turnCompleted ? 'stop' : ''
}

/**
 * 组子进程的环境变量。
 *
 * ★ 默认**逐字节沿用 `process.env`**（不加任何键）—— 修复前就是这样，不改变现有行为。
 * 只有用户**显式配了**下面这两项才注入对应的键：
 *   · `provider.proxy`     → `HTTPS_PROXY` / `HTTP_PROXY`
 *   · `provider.codexHome` → `CODEX_HOME`
 *
 * ── 为什么代理要显式传（证据见设计 §5.6）─────────────────────
 *
 * 本机 `chatgpt.com` 直连不通，codex 必须走代理；而代理常见形态是**用户级环境变量**
 * —— 从资源管理器/桌面快捷方式启动的进程不一定继承到它，症状是「模型没有输出」。
 *
 * ── ★★ 为什么 CODEX_HOME 只设环境变量、绝不碰那个目录 ────────
 *
 * 该目录里有 ChatGPT 的**登录凭据**（`auth.json`）。用户明令（2026-10-17 第 3 条）：
 * **不得自动复制、迁移或删除认证文件**。所以这里**只设一个环境变量**：
 * 不 `mkdir`、不读、不写、不复制、不删除 —— 那个目录存不存在、里面有什么，
 * 全由 codex 自己管。配了之后需要在**新目录**重新登录（卡片上有提示）。
 *
 * @param {object} provider
 */
function buildEnv(provider) {
  const proxy = String(provider?.proxy ?? '').trim()
  const codexHome = String(provider?.codexHome ?? '').trim()
  /* ★ 两项都没配 → 原样返回 process.env（**同一个引用**，自检钉住这条） */
  if (!proxy && !codexHome) return process.env
  const env = { ...process.env }
  if (proxy) {
    env.HTTPS_PROXY = proxy
    env.HTTP_PROXY = proxy
  }
  if (codexHome) env.CODEX_HOME = codexHome
  return env
}

/** 把 stderr 尾部与进度提示收成一句人话（空输出时报错用）——**不猜**，只转述 */
function explainEmpty(state, stderrTail) {
  const notices = state.notices.map((n) => String(n).trim()).filter(Boolean)
  const parts = []
  if (stderrTail.trim()) parts.push(`codex 输出：${stderrTail.trim().slice(-300)}`)
  if (notices.length > 0) parts.push(`codex 提示：${notices.slice(-3).join(' / ').slice(-300)}`)
  return parts.join('；')
}

/**
 * 走 codex CLI 跑一次对话（同形）。失败抛异常 —— 与 `llm.chatStream` 同语义
 * （上游错误 → throw，取消 → AbortError），好让 `loop-model` 的重试/降级照常工作。
 *
 * @param {object} options 见文件头「同形契约」
 * @returns {Promise<{ content: string, reasoning: string, toolCalls: Array, usage: object|null,
 *           finishReason: string, ttftMs: number|null, latencyMs: number,
 *           codexNotices: string[], threadId: string }>}
 */
async function chatStream(options = {}) {
  const startedAt = Date.now()
  const provider = options.provider && typeof options.provider === 'object' ? options.provider : {}
  const model = String(options.model ?? '')
  const launcher = resolveLauncher(provider.codexPath)
  const prompt = buildPrompt(options.messages, { tools: options.tools })
  const state = newState()
  let ttftMs = null

  const res = await runCodex({
    launcher,
    prompt,
    cwd: options.cwd ?? options.workdir,
    /* 配了 provider.proxy 才注入代理环境变量；没配就是原样 process.env */
    env: buildEnv(provider),
    signal: options.signal,
    /* codex 自己的宽超时（刻意不用 idleTimeoutMs —— 那是 HTTP 路径的约定） */
    idleMs: DEFAULT_IDLE_MS,
    totalMs: DEFAULT_TOTAL_MS,
    onEvent: (event) => {
      const before = state.text.length
      applyEvent(state, event)
      const grew = state.text.length - before
      if (grew > 0) {
        if (ttftMs === null) ttftMs = Date.now() - startedAt
        /* item 级：一次给一整段（如实，不假装逐字） */
        options.onContent?.(state.text.slice(before))
      }
    },
  })

  /* ① 取消：与 HTTP 路径同一形状 —— 上层按 AbortError 处理，不记故障 */
  if (res.aborted || options.signal?.aborted) throw new DOMException('aborted', 'AbortError')

  /* ② 超时：说清「等了多久」与下一步怎么办 */
  if (res.timedOut) {
    const secs = Math.round(DEFAULT_TOTAL_MS / 1000)
    throw new Error(
      `codex 没有在期限内给出结果（最多等 ${secs} 秒，期间可能一直没输出）。` +
        `本机首次调用 codex 常常很慢（需要代理 + 重连）；稍后重试，或在设置里确认 Codex 后端的启动器路径。`,
    )
  }

  /* ③ 起不来（没装 / 路径不对）—— 如实指路 */
  if (res.spawnError) {
    throw new Error(
      `起不了 codex（${res.spawnError}）。请确认本机已安装 ChatGPT Codex CLI 并已登录；` +
        `不在 PATH 里的话，在设置 → 模型里给这个后端填一个启动器路径。`,
    )
  }

  /* ④ 空输出：**不假装成功** —— 把 codex 的原话转述出来（这多半是没登录 / 网络 / 模型不可用） */
  if (!state.text.trim()) {
    const why = explainEmpty(state, res.stderrTail)
    throw new Error(
      `codex 没有返回任何内容（模型 ${model}）。常见原因：CLI 未登录、网络不通（本机需代理）、` +
        `或该模型当前不可用。${why ? ` ${why}` : ''}`,
    )
  }

  if (state.usage) options.onUsage?.(state.usage)
  /*
   * ★ 不调 `onToolCalls` —— 这条后端产不出工具调用（文件头 ①）。
   *   调了会让人以为「有工具可用」，而下一次就会去执行一个并不存在的调用。
   */

  return {
    content: state.text,
    reasoning: '',
    toolCalls: [],
    usage: state.usage,
    finishReason: finishReasonOf(state),
    ttftMs,
    latencyMs: Date.now() - startedAt,
    /* 额外信息：不破坏同形契约（加字段安全），给上层做提示/诊断用 */
    codexNotices: state.notices,
    threadId: state.threadId,
  }
}

module.exports = { chatStream, finishReasonOf, explainEmpty, buildEnv }
