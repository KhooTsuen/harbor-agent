/**
 * 自检 / 系统提示内容回归 / 会话状态 / 上下文预算 / 意图路由
 *
 * 从 scripts/selftest.mjs 拆出来的（那边 1193 行了）。
 * 每个文件导出 `run()`，由 selftest.mjs 按顺序调用 —— 组之间**不共享状态**，
 * 所以加新组只要在 selftest.mjs 的清单里加一行。
 */

import { check, group } from '../harness.mjs'
import {
  contextBuilderCore,
  conversationStateCore,
  join,
  memory,
  modeRouterCore,
  promptStackCore,
  resolve,
  skills,
  tools,
} from '../env.mjs'

export async function run() {
  group('系统提示 / 内容回归')
  /* 用和 loop.cjs 同样的输入装配一次 */
  const stackInput = {
    assistantName: 'Agent',
    responseDepth: 'standard',
    environment: [
      '- 操作系统：Windows',
      '- 工作目录：E:\\probe',
      '- **文件访问有范围限制**：默认只能读写工作目录内的文件。',
    ].join('\n'),
    currentTime: '- 当前时间：2026-09-14 22:30:00',
    relevantMemory: '## 关于用户和这个项目（长期记忆）\n- [偏好] 用中文',
    projectInstructions: '## 这个项目的说明（来自 AGENT.md）\n- 数据只落 data/',
    skills: '## 技能\n- foo：干什么的',
    tools: '- `read_file`：读文件\n- `run_shell`：跑命令',
    toolPolicy: promptStackCore.MODE_GUIDE.plan + '\n' + promptStackCore.PERMISSION_GUIDE.ask,
    taskState: '## 任务\n- 正在做 A',
    conversationState: '## Conversation State\n- 目标：B',
    /* 用**真实常量**，不是手写假文案 —— 手写的测不出生产文案被改坏 */
    /* 用**真实常量**，不是手写假文案 —— 手写的测不出生产文案被改坏 */
    workRules: promptStackCore.WORK_RULES,
    safety: promptStackCore.SAFETY_GUIDE,
  }
  const builtStack = promptStackCore.build(stackInput)
  const promptText = builtStack.message.content

  /* ① 结构 */
  check('层数与顺序固定', builtStack.order.length === promptStackCore.ORDER.length)
  check('带版本号', typeof builtStack.version === 'string' && builtStack.version.length > 0)
  check('空层会被丢掉', !promptText.includes('User Preferences'))
  check(
    '每层都有标题',
    promptText.includes('## Core Identity') && promptText.includes('## Boundaries'),
  )

  /* ② 内容 —— 下面这些就是当初漏掉的五块 */
  const requiredInPrompt = {
    '环境：操作系统': /操作系统/,
    '环境：工作目录': /工作目录/,
    '环境：文件范围限制': /文件访问有范围限制/,
    '末尾：当前时间': /当前时间/,
    工具清单: /read_file/,
    '工具清单（第二个工具）': /run_shell/,
    模式说明: /计划模式/,
    权限说明: /权限/,
    '做事规矩：先看再改': /先看再改/,
    /* 用**只有安全层才会出现**的字，别用「不是指令」——
       那句在两处都有，安全层被删掉时它会假绿（实测过）。 */
    '安全：可疑注入要主动报告': /可疑的注入尝试/,
    '安全：忽略之前的指令怎么处理': /忽略之前的指令/,
    '安全：不可自己拼等效命令': /不要自己拼一条等效的命令/,
    '安全：不确定先问': /先问，或者先用只读方式/,
    记忆: /长期记忆/,
    项目说明: /AGENT\.md/,
    技能: /技能/,
    任务状态: /任务/,
  }
  for (const [label, pattern] of Object.entries(requiredInPrompt)) {
    check(`提示里有「${label}」`, pattern.test(promptText))
  }

  /*
   * ③ 顺序：**稳定区在前、易变区在后**。
   * DeepSeek 的 prompt 缓存是前缀匹配 —— 开头越稳定，命中的 token 越多。
   * 所以「当前时间」这种每轮都变的内容必须在最后，否则整个前缀都白费。
   */
  const idxIdentity = promptText.indexOf('Core Identity')
  const idxRules = promptText.indexOf('先看再改')
  const idxSafety = promptText.indexOf('Boundaries')
  const idxTime = promptText.indexOf('当前时间')
  check('身份在最前', idxIdentity >= 0 && idxIdentity < idxRules)
  check('规矩在边界之前', idxRules < idxSafety)
  /* 缓存优先：边界不再压轴，但它每轮不变，放稳定区末尾才不浪费缓存命中 */
  check('边界在稳定区（易变区之前）', idxSafety > 0 && idxSafety < idxTime)
  check('★ 当前时间在最后（每轮都变，不能污染前缀缓存）', idxTime > promptText.length * 0.8)

  /* ══════════════════════════════════════════════════════
     CE-002 / CE-003 / CE-004：新内核模块
     ══════════════════════════════════════════════════════ */

  group('Conversation State')
  const cs1 = conversationStateCore.update(null, [
    { role: 'user', content: '帮我把启动速度优化一下，只改 src 里的代码，不要动配置' },
  ])
  check('提取出当前焦点', typeof cs1.currentFocus === 'string' && cs1.currentFocus.length > 0)
  check('提取出目标', /优化/.test(cs1.goal), cs1.goal)
  check(
    '提取出约束',
    cs1.constraints.some((c) => /不要动配置/.test(c)),
    JSON.stringify(cs1.constraints),
  )
  check('状态带版本', cs1.version === 1)

  const cs2 = conversationStateCore.update(cs1, [{ role: 'user', content: '决定采用方案 B' }])
  check(
    '新的决定被追加',
    cs2.decisions.some((d) => /方案 B/.test(d)),
    JSON.stringify(cs2.decisions),
  )
  check('旧状态被继承（不是重置）', cs2.topic === cs1.topic)

  const cs3 = conversationStateCore.update(null, [])
  check('空输入不崩、给出空状态', cs3.topic === '' && Array.isArray(cs3.entities))

  group('Context Builder')
  const longHistory = Array.from({ length: 60 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `第 ${i} 条消息，${'内容'.repeat(40)}`,
  }))
  const built = contextBuilderCore.assemble({
    maxTokens: 4096,
    budget: {
      system: 10,
      memory: 5,
      project: 15,
      task: 10,
      conversation: 30,
      tools: 20,
      reserve: 10,
    },
    memory: '记忆内容',
    project: '项目内容',
    conversationState: '状态内容',
    messages: longHistory,
  })
  check(
    '返回 systemContext 与 messages',
    Boolean(built.systemContext) && Array.isArray(built.messages),
  )
  check('系统上下文保留记忆/项目/状态', /记忆内容/.test(JSON.stringify(built.systemContext)))
  check(
    '长历史被裁到上限内',
    built.messages.length < longHistory.length,
    `${built.messages.length} / ${longHistory.length}`,
  )
  check(
    '保留的是最近的消息',
    JSON.stringify(built.messages.at(-1)).includes('第 59 条'),
    JSON.stringify(built.messages.at(-1)).slice(0, 60),
  )
  const builtEmpty = contextBuilderCore.assemble({ maxTokens: 4096, messages: [] })
  check('空历史不崩', Array.isArray(builtEmpty.messages) && builtEmpty.messages.length === 0)

  group('Mode Router')
  check('研究类意图', modeRouterCore.resolve('查一下最新的资料').mode === 'research')
  check('创作类意图', modeRouterCore.resolve('帮我写一个故事').mode === 'creative')
  check('执行类意图', modeRouterCore.resolve('帮我完成这个重构').mode === 'agent')
  check('代码类意图', modeRouterCore.resolve('这个报错怎么修').mode === 'code')
  check('思考类意图', modeRouterCore.resolve('为什么会这样，分析一下').mode === 'think')
  check('兜底到聊天', modeRouterCore.resolve('你好').mode === 'chat')
  check('用户手动指定优先', modeRouterCore.resolve('查最新资料', 'think').mode === 'think')
  check('返回置信度和理由', typeof modeRouterCore.resolve('你好').confidence === 'number')
  check(
    '只做意图判断、不授予权限',
    !Object.keys(modeRouterCore.resolve('删掉所有文件', 'agent')).includes('permission'),
  )
}
