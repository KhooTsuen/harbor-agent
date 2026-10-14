/**
 * 自检 / CE-018：易变区独立成第二条 system message（前缀缓存）
 *
 * 症结：所有层以前拼在**同一条** system message 里。服务端 prompt 缓存是**前缀匹配**，
 * 易变区（记忆 / 任务 / 会话状态 / 当前时间）动一个字，它**后面**的一切 —— 包括整段
 * 历史消息 —— 全部失效。真实 DeepSeek usage 实测（同历史 / 同任务，只改易变层）：
 *   · 现状（同一条）：未命中 45,887 token / 命中率 16.3%
 *   · 候选（拆两条）：未命中    192 token / 命中率 99.6%
 *
 * 改法：`prompt-stack.splitMessages` 把层拆成稳定区一条、易变区一条；`loop-prompt.cjs`
 * 拼成 `[稳定区, ...历史, 易变区]`。
 *
 * 四条必须钉住（少一条就会悄悄退化）：
 *   ① 拆出的两条**拼回来**与 `build().message` 逐字节相同（内容一字未改）；
 *   ② 稳定区那条**不含**易变层（否则拆分等于没做）；
 *   ③ 角色仍是 `system`（**绝不降级成 user** —— 那会削弱指令权威性）；
 *   ④ 生产真的这么拼（易变区在历史**之后**），不是只写了个没人调的纯函数。
 */

import { check, group } from '../harness.mjs'
import { join, promptStackCore, readFileSync, ROOT } from '../env.mjs'

export async function run() {
  const loopPromptSrc = readFileSync(join(ROOT, 'electron/core/loop-prompt.cjs'), 'utf8')

  group('CE-018 / 易变区独立 system message')

  const built = promptStackCore.build({
    assistantName: 'Agent',
    responseDepth: 'standard',
    environment: '- 操作系统：Windows',
    currentTime: '- 当前时间：2026-09-14 22:30:00',
    relevantMemory: '## 关于用户和这个项目（长期记忆）\n- [偏好] 用中文',
    projectInstructions: '## 这个项目的说明\n- 数据只落 data/',
    tools: '- `read_file`：读文件',
    toolPolicy: promptStackCore.MODE_GUIDE.pair,
    browserGuide: promptStackCore.BROWSER_GUIDE,
    workRules: promptStackCore.WORK_RULES,
    safety: promptStackCore.SAFETY_GUIDE,
    taskState: '## Task State\n- 正在做 A',
    conversationState: '## Conversation State\n- 目标：B',
  })

  const msgs = promptStackCore.splitMessages(built.layers)
  check('★ 拆成两条 message', msgs.length === 2, `${msgs.length}`)
  check(
    '★ 两条都是 system（**绝不降级成 user**：会削弱指令权威性）',
    msgs.every((m) => m.role === 'system'),
    msgs.map((m) => m.role).join(','),
  )
  check(
    '★ 拼回来与 build().message 逐字节相同（只挪位置、内容一字未改）',
    msgs.map((m) => m.content).join('\n\n') === built.message.content,
  )
  check(
    '★ 稳定区那条不含易变层（否则拆了等于没拆）',
    !msgs[0].content.includes('Relevant Memory') &&
      !msgs[0].content.includes('Current Time') &&
      !msgs[0].content.includes('Task State') &&
      !msgs[0].content.includes('Conversation State'),
  )
  check(
    '★ 稳定区那条仍在最前（身份在最前、边界在稳定区末尾）',
    msgs[0].content.includes('Core Identity') && msgs[0].content.includes('Boundaries'),
  )
  check(
    '★ 易变区那条装的是易变层（记忆 / 任务 / 状态 / 时间）',
    msgs[1].content.includes('Relevant Memory') &&
      msgs[1].content.includes('Task State') &&
      msgs[1].content.includes('Conversation State') &&
      msgs[1].content.includes('当前时间'),
  )

  /* 稳定层名单从 ORDER 派生 —— 只有一处真相源，加层不用改第二份名单 */
  check(
    '★ 稳定名单从 ORDER 派生（workRules / safety 稳定；易变三层不稳定）',
    promptStackCore.STABLE_IDS.has('workRules') &&
      promptStackCore.STABLE_IDS.has('safety') &&
      promptStackCore.STABLE_IDS.has('projectInstructions') &&
      !promptStackCore.STABLE_IDS.has('relevantMemory') &&
      !promptStackCore.STABLE_IDS.has('taskState') &&
      !promptStackCore.STABLE_IDS.has('conversationState') &&
      !promptStackCore.STABLE_IDS.has('currentTime'),
  )
  check(
    '★ 稳定名单与易变名单加起来正好是全部层（不漏层）',
    promptStackCore.STABLE_IDS.size === promptStackCore.ORDER.indexOf('relevantMemory') &&
      promptStackCore.ORDER.indexOf('relevantMemory') > 0,
  )

  /* ── 生产接线：真的按这个顺序拼 ── */
  check('★ loop-prompt 调用了 splitMessages', /promptStack\.splitMessages\(/.test(loopPromptSrc))
  check(
    '★ 易变区拼在历史**之后**（...assembled.messages 之后才是 variable）',
    /\.\.\.assembled\.messages[\s\S]{0,160}?variable/.test(loopPromptSrc),
  )
  check(
    '★ 首条 message 是稳定区（head，不是旧的 systemPrompt 单条）',
    /const messages = \[\.\.\.head, \.\.\.assembled\.messages/.test(loopPromptSrc),
  )
  /* 旧的单条拼法必须彻底退场 —— 留着它会和新的并行（两处真相源） */
  check(
    '★ 旧的「单条 systemPrompt」拼法已退场',
    !/const messages = \[\{ role: 'system', content: systemPrompt \}/.test(loopPromptSrc),
  )
}
