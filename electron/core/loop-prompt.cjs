/**
 * Agent 循环：系统提示装配
 *
 * 从 loop.cjs 拆出来的（那边过 300 行了）。
 *
 * 这里回答「这一轮要跟模型说什么」：环境（时间/系统/工作目录）、工具与技能清单、
 * 相关记忆、项目说明、会话状态、历史消息，最后按分层拼成系统提示。
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
const memory = require('./memory.cjs')
const project = require('./project.cjs')
const promptStack = require('./prompt-stack.cjs')
const { MODE_GUIDE, PERMISSION_GUIDE, SAFETY_GUIDE, WORK_RULES } = promptStack
const contextBuilder = require('./context-builder.cjs')
const conversationState = require('./conversation-state.cjs')
const sessionCore = require('./session.cjs')

/* ══════════════════════════════════════════════════════════
   系统提示词
   ══════════════════════════════════════════════════════════ */

/**
 * 环境信息（**静态部分**）。
 *
 * 只有「操作系统 / 工作目录 / 文件访问范围」这些基本不变的东西。
 * ⚠️ 当前时间**不在这里** —— 它每轮都变，放这层会把整个提示的缓存前缀冲掉。
 * 见 `currentTimeSection()`。
 */
function environmentSection({ workdir, assistantName = 'Agent' }) {
  return [
    `- 操作系统：${process.platform === 'win32' ? 'Windows' : process.platform}`,
    `- 工作目录：${workdir}`,
    '- 相对路径一律理解为相对工作目录。',
    '- **文件访问有范围限制**：默认只能读写工作目录内的文件。需要动外面的时候，',
    '  直接按绝对路径调用工具即可 —— 应用会弹窗让用户批准，批准后本次会话有效。',
    '  被拒绝时不要反复重试，问用户想怎么办。',
    `- 你是 ${assistantName}，跑在用户本机上。`,
  ].join('\n')
}

/**
 * 当前时间 —— **单独一层，放最后**。
 *
 * 它是唯一**每轮都变**的内容。DeepSeek 的 prompt 缓存是前缀匹配，
 * 把它放在开头等于让后面所有 token 每轮都没法命中。放最后，
 * 前面稳定的部分就能一直命中（命中 token 约 1/10 价）。
 */
function currentTimeSection() {
  return `- 当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`
}

/**
 * 工具清单。
 *
 * function calling 的 schema 里已经带了每个工具的描述，但**一句导航能省很多试错**：
 * 模型知道「有没有能读目录的工具」，就不会拿 shell 去凑。
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
  return builtin.join('\n')
}

/**
 * 装配这一轮要发出去的消息。
 *
 * @param {{ config: object, workdir: string, mode: string, history: Array,
 *           threadSettings: object, options: object }} input
 * @returns {{ messages: Array }}
 */
function buildPromptContext({ config, workdir, mode, history, threadSettings, options }) {
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

  /* CE-003：按预算选择近期消息，系统层仍保持独立可调试。 */
  const assembled = contextBuilder.assemble({
    maxTokens: config.assistant.maxTokens,
    budget: config.context?.budget,
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
  const stack = promptStack.build({
    assistantName: config.assistant.name,
    responseDepth: threadSettings.responseDepth ?? config.assistant.responseDepth ?? 'standard',
    /* 时间 / 系统 / 工作目录 / 文件访问范围 */
    environment: environmentSection({ workdir, assistantName: config.assistant.name }),
    relevantMemory: assembled.systemContext.memory,
    projectInstructions: assembled.systemContext.project,
    /* 技能与工具清单：模型得看得到「手边有什么」 */
    skills: skillSection,
    tools: toolsSection(),
    toolPolicy: `${MODE_GUIDE[mode] ?? MODE_GUIDE.pair}\n${PERMISSION_GUIDE[config.tools.permission] ?? PERMISSION_GUIDE.ask}`,
    taskState: options.taskState ?? '',
    conversationState: assembled.systemContext.conversationState,
    userPreferences: '',
    retrievedContext: '',
    /* 最后两层：越靠后越容易被遵守 */
    workRules: WORK_RULES,
    safety: SAFETY_GUIDE,
    /* 当前时间单独一层，放在最末（它每轮都变，不能污染前面的缓存前缀） */
    currentTime: currentTimeSection(),
  })
  const systemPrompt = config.assistant.systemPrompt?.trim()
    ? `${config.assistant.systemPrompt}\n\n${stack.message.content}`
    : stack.message.content

  const messages = [{ role: 'system', content: systemPrompt }, ...assembled.messages]
  if (options.sessionId) {
    try {
      sessionCore.appendState(options.sessionId, state)
    } catch {
      /* 状态更新不能阻塞主对话 */
    }
  }

  return { messages }
}

module.exports = { buildPromptContext }
