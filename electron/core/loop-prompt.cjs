/**
 * Agent 循环：系统提示装配
 *
 * 从 loop.cjs 拆出来的（那边过 300 行了）。
 *
 * 这里回答「这一轮要跟模型说什么」：环境（时间/系统/工作目录）、工具与技能清单、
 * 相关记忆、项目说明、会话状态、历史消息，最后按分层拼成系统提示。
 * ⚠️ 前两层的**正文**在 prompt-env.cjs（那边写了为什么搬 + 两个坑）。
 *
 * ⚠️ 出过一次事故：改成分层时漏了「环境 / 工具清单 / 模式说明 / 做事的规矩 /
 * 安全边界」五块 —— 模型于是不知道今天几号，也失去了注入边界。
 * 现在 `scripts/selftest.mjs` 里有「系统提示 / 内容回归」盯着，
 * 少一块就会红。别再靠「看着没问题」。
 */

const log = require('./log.cjs')
const tools = require('./tools/index.cjs')
const plugins = require('./plugins.cjs')
const skills = require('./skills.cjs')
const skillPin = require('./skill-pin.cjs')
const memory = require('./memory.cjs')
const project = require('./project.cjs')
const perfMarks = require('./perf-marks.cjs')
const promptStack = require('./prompt-stack.cjs')
const { environmentSection, currentTimeSection } = require('./prompt-env.cjs')
const clarifyTurn = require('./clarify-turn.cjs')
const machineEnv = require('./machine-env.cjs')
const mcpHint = require('./mcp-hint.cjs')
const { MODE_GUIDE, PERMISSION_GUIDE, SAFETY_GUIDE, workRules, BROWSER_GUIDE } = promptStack
const contextBuilder = require('./context-builder.cjs')
const contextWindow = require('./context-window.cjs')
const conversationState = require('./conversation-state.cjs')
const sessionCore = require('./session.cjs')
const contextDiag = require('./context-diag.cjs')
const templates = require('./templates.cjs')
const taskNotes = require('./task-notes.cjs')
const taskHint = require('./task-hint.cjs')

/* ══════════════════════════════════════════════════════════
   系统提示词
   ══════════════════════════════════════════════════════════ */

/**
 * AG-017：失败后的「进度对照」。
 *
 * 为什么在模型**明明能看到历史**的情况下还要写这个：
 * **历史会被压缩**（AG-016 的 ContextOverflow → Compact）—— 压完之后
 * 早期步骤只剩摘要里的一句话，细节就模糊了，那时候模型有可能会「保险起见
 * 从头再来」。而任务台账在磁盘上、不受压缩影响，所以在这里把
 * 「哪些成了、哪个败了」再明确说一遍，并且直说「成功的别重做」。
 *
 * 文档对这一条的描述：
 *   Step 1 ✓ / Step 2 ✓ / Step 3 ✗ → 分析失败 → 调整 Step 3 → 继续
 *   **禁止从 Step 1 重新开始**
 */
function buildFailureNote({ done = [], failed = [] } = {}) {
  const lines = []
  if (done.length > 0) lines.push(`本轮已完成：${done.join('、')}`)
  for (const item of failed) {
    /* 结构化失败摘要（token 优化 §六）：error_kind / 目标 / 重试次数 —— 不重注全文 */
    const bits = [`失败：${item.name}`]
    if (item.target) bits.push(`目标=${String(item.target).slice(0, 120)}`)
    if (item.kind) bits.push(`error_kind=${item.kind}`)
    if (item.retryCount) bits.push(`retry_count=${item.retryCount}`)
    bits.push(item.hint || '原因不明')
    lines.push(bits.join(' · '))
    if (item.partial?.changed || item.partial?.created) {
      lines.push(
        `  ⚠ ${item.partial.path} ${item.partial.created ? '已被创建' : '可能已被部分修改'} —— 重试前先 read_file 看现场，不要盲目重来`,
      )
    }
  }
  lines.push('请**针对失败的那一步调整做法**（换参数、换工具，或先把原因查清楚），')
  lines.push('**已经成功的不必重做** —— 从失败的那一步接着往下走。')
  return `[上一轮执行情况]\n${lines.join('\n')}`
}

/**
 * 工具清单。
 *
 * function calling 的 schema 里已经带了每个工具的描述，但**一句导航能省很多试错**：
 * 模型知道「有没有能读目录的工具」，就不会拿 shell 去凑。
 *
 * 分三块：内置工具 → 本地插件 → MCP 服务器（`mcp-hint.cjs`）。
 * 后两块都是「这里有个入口，细节在 schema 里」，不重复写参数。
 */
function toolsSection() {
  const builtin = tools.ALL.map((t) => `- \`${t.name}\`：${t.description.split('。')[0]}。`)
  /*
   * 本地插件清单：单独一段，让模型在**文字层面**知道有哪些插件、何时用。
   * 这是「两段式」的第一段（清单）；完整参数 schema 在 function calling 里。
   * 插件多了以后，这里会变成「清单 → 按需注入 schema」的入口。
   */
  const pluginList = plugins.pluginList()
  if (pluginList) {
    builtin.push('\n【本地插件（装在 data/plugins/ 下，各自描述为准）】')
    builtin.push(pluginList)
  }
  /* MCP 服务器：连上了才写，免得新对话一开始就列一堆连不上的名字 */
  const remote = mcpHint.live()
  if (remote) builtin.push(remote)
  return builtin.join('\n')
}

/**
 * 装配这一轮要发出去的消息。
 *
 * @param {{ config: object, workdir: string, mode: string, history: Array,
 *           threadSettings: object, options: object, model?: string, provider?: object }} input
 * @returns {{ messages: Array, promptVersion: string }}
 */
function buildPromptContext({ config, workdir, mode, history, threadSettings, options, model, provider }) {
  /* AG-037：这段（提示词拼装 + 记忆召回 + 项目说明）自己计时，循环那边只管编排 */
  const startedAt = Date.now()
  const traceId = String(options?.traceId || options?.taskId || '')
  /* 这轮用户说了什么 —— 模板匹配 / 记忆召回的查询词共用 */
  const lastUserText = (() => {
    const list = options?.history ?? history ?? []
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i]
      if (m?.role === 'user' && typeof m.content === 'string' && m.content.trim()) return m.content
    }
    return ''
  })()
  /*
   * 他这轮明确说「你问我几个问题」→ 当场解除静音（AG-053 批④）。
   *
   * 界面那个「先问我想清楚」按钮做的就是**把这句话填进输入框**（他还能再补两句），
   * 所以这里认出来就够了 —— 不必为它开一条新 IPC 通道，也不用让渲染层去猜内核状态。
   * 静音只是一次性的「别老问了」，不是偏好，所以解除也不写盘。
   * 为什么单独一个 clarify-turn.cjs：这段逻辑要跟工具侧（ask_user 的 muted）读同一份状态，
   * 判断只能有一处；另外这个文件本来就贴着 300 行。
   */
  /* 技能清单：只给名字 + 用途 + 路径，正文让模型自己按需读 */
  let skillSection = ''
  try {
    skillSection = skills.buildPromptSection(skills.list())
  } catch (error) {
    log.warn(`读技能失败：${error instanceof Error ? error.message : error}`)
  }

  /*
   * 记忆：**按相关性挑**，不是整篇塞。
   * 用最后一条用户消息当查询词 —— 这轮要干什么，是判断「哪条记忆相关」的最好线索。
   */
  let memorySection = ''
  try {
    if (threadSettings.useMemory !== false) memory.ensureMigrated()
    const lastUser = [...(options.history ?? [])].reverse().find((m) => m.role === 'user')
    memorySection =
      threadSettings.useMemory === false
        ? ''
        : memory.buildPromptSection({
            query: typeof lastUser?.content === 'string' ? lastUser.content : '',
            projectId: options.projectId ?? '',
            /* 会话私有记忆只在本会话注入（SEC-065）——没有 sessionId 就一条都不注入 */
            sessionId: options.sessionId ?? '',
          })
  } catch (error) {
    log.warn(`读记忆失败：${error instanceof Error ? error.message : error}`)
  }

  /* 项目说明：AGENT.md 之类，项目维护者写的规矩 */
  let projectSection = ''
  try {
    projectSection = project.buildPromptSection({ workdir })
  } catch (error) {
    log.warn(`读项目说明失败：${error instanceof Error ? error.message : error}`)
  }

  /* CE-002：从会话恢复独立状态；状态损坏只回退为空，不影响聊天。 */
  let state = null
  if (options.sessionId) {
    try {
      state = sessionCore.load(options.sessionId)?.state ?? null
    } catch {
      state = null
    }
  }
  state = conversationState.update(state, history)

  /* CE-003：按预算选择近期消息，系统层仍保持独立可调试。
     token 优化：软预算时把「记忆」配额减半（先砍低相关记忆，不砍验证与安全）。 */
  const baseBudget = config.context?.budget
  const softBudget =
    options.budgetSoft === true && baseBudget
      ? { ...baseBudget, memory: Math.max(1, Math.floor((Number(baseBudget.memory) || 5) / 2)) }
      : baseBudget
  const assembled = contextBuilder.assemble({
    /* 基准 = min(模型窗口×80%, 用户上限)；算法只在 context-window.cjs 一处（见该文件头） */
    maxTokens: contextWindow.effectiveBaseTokens({ config, provider, model }),
    budget: softBudget,
    memory: memorySection,
    project: projectSection,
    conversationState: conversationState.prompt(state),
    messages: history,
  })
  /*
   * 分层拼系统提示。
   *
   * ⚠️ 这里出过一次事故：改成分层时漏了「环境 / 工具清单 / 模式说明 /
   * 做事的规矩 / 安全边界」五块 —— 模型于是不知道今天几号，也失去了注入边界。
   * 现在 `scripts/selftest.mjs` 里有一组「系统提示内容回归」盯着这些，
   * 少一块就会红。别再靠「看着没问题」。
   */
  /* 任务模板建议（token 优化 §七）：只在「新任务开跑」时给，不抢已有计划的位。
     ⚠️ TOK-P2-004：不能判「taskState 非空」—— 新活第一轮注入的
     「本轮请求（还没立任务）」段也是非空（chat.cjs 的 freshRequest 兜底）。
     用 taskHint.isFreshTaskState 等值判断，见 task-hint.cjs 的注释。 */
  const templateHit = taskHint.isFreshTaskState(options.taskState, lastUserText)
    ? templates.match(lastUserText)
    : null
  const templateHint = templateHit ? templates.hintOf(templateHit) : ''
  if (templateHit && options.taskId) {
    try {
      taskNotes.recordTemplate(options.taskId, templateHit)
    } catch {
      /* 记不上不影响对话 */
    }
  }

  const stack = promptStack.build({
    assistantName: config.assistant.name,
    responseDepth: threadSettings.responseDepth ?? config.assistant.responseDepth ?? 'standard',
    /* 时间 / 系统 / 工作目录 / 文件访问范围 */
    environment: environmentSection({ workdir, assistantName: config.assistant.name }),
    /* 这台机器上有什么：shell 是 cmd.exe、装了哪些命令、哪些没装。
       内容由 machine-env.cjs 启动时探一次存住（`main.cjs` 里 warm）——
       所以这里只读缓存，不 spawn 进程。 */
    machineEnv: machineEnv.section(),
    relevantMemory: assembled.systemContext.memory,
    projectInstructions: assembled.systemContext.project,
    /* 技能与工具清单：模型得看得到「手边有什么」；
       钉住的那个技能把**正文**也放进来（见 skill-pin.cjs），否则「钉」等于没钉 */
    skills: [skillSection, skillPin.promptSection(threadSettings)].filter(Boolean).join('\n\n'),
    tools: toolsSection(),
    toolPolicy: `${MODE_GUIDE[mode] ?? MODE_GUIDE.pair}\n${PERMISSION_GUIDE[config.tools.permission] ?? PERMISSION_GUIDE.ask}`,
    /* 浏览器怎么用（顺序 / 先看再动 / 动完重看）—— 让模型跟着人用网页的方式走 */
    browserGuide: BROWSER_GUIDE,
    taskState: [options.taskState ?? '', templateHint].filter(Boolean).join('\n\n'),
    conversationState: assembled.systemContext.conversationState,
    userPreferences: '',
    retrievedContext: '',
    /* 最后两层：越靠后越容易被遵守 */
    /*
     * `assistant.planFirst` / `clarifyFirst`（AG-053）的控制点；
     * 两条规则的原文与理由见 prompt-stack.cjs。
     *
     * ★ 「现在还能不能问他」一次算清（批④ 接的），判断在 clarify-turn.cjs ——
     * 以前这里读的是 `options.clarifyMuted`，而**那个字段根本没人赋值**：
     * 静音之后提示词里照旧写着「先问」，模型就去问了，工具却拒答（两边说法不一致）。
     */
    workRules: workRules({
      planFirst: config.assistant?.planFirst,
      clarifyFirst: config.assistant?.clarifyFirst,
      /* A2：规模层也有自己的开关（关掉 = 闸门与这条规矩一起退场） */
      scaleFirst: config.assistant?.scaleFirst,
      clarifyMuted: clarifyTurn.mutedFor({ sessionId: options.sessionId, lastUserText }),
    }),
    safety: SAFETY_GUIDE,
    /* 当前时间单独一层，放在最末（它每轮都变，不能污染前面的缓存前缀） */
    currentTime: currentTimeSection(),
  })
  const systemPrompt = config.assistant.systemPrompt?.trim()
    ? `${config.assistant.systemPrompt}\n\n${stack.message.content}`
    : stack.message.content

  /* 三层诊断（token 优化）：hash + 「稳定前缀变了没、变在哪层」—— 只进台账与日志 */
  const diag = contextDiag.diagnose(stack.layers, {
    sessionId: options.sessionId ?? '',
    promptVersion: stack.version,
  })
  if (diag.stablePrefixChanged) {
    log.warn(`稳定前缀发生变化：${diag.stablePrefixChangeReason || 'unknown'}（任务 ${options.taskId ?? '-'}）`)
  }
  if (options.taskId) {
    try {
      taskNotes.recordPromptDiag(options.taskId, diag)
    } catch {
      /* 诊断写不进不影响对话 */
    }
  }

  const messages = [{ role: 'system', content: systemPrompt }, ...assembled.messages]
  if (options.sessionId) {
    try {
      sessionCore.appendState(options.sessionId, state)
    } catch {
      /* 状态更新不能阻塞主对话 */
    }
  }

  perfMarks.mark(traceId, 'context', Date.now() - startedAt)
  /* ②-1：把提示词版本一并交出去，循环那边记进任务台账 */
  return { messages, promptVersion: stack.version, diag }
}

module.exports = { buildPromptContext, buildFailureNote }
