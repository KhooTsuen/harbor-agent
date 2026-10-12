/**
 * 自检 / CE-005 任务感知 persona（Phase 6 批次 1）
 *
 * 参考 dsh-routing-suite：同一模型在不同任务上表现差异巨大，按任务**分类**
 * 注入不同的「做派」。Harbor 的落地（见 docs/research/phase6-governance-routing-design.md）：
 *
 *   · 分类器 = `mode-router.personaFor` —— **纯正则**，复用已有的 `resolve` 结果
 *     （mode → persona 映射），绝不引入 LLM 调用；
 *   · **首轮锁定** —— 由**第一条真实用户消息**定，纯函数所以不需要任何状态/落盘；
 *   · 注入 = `prompt-stack` 的 `personaGuide` 层，放**稳定区**（首轮之后逐轮不变，
 *     吃前缀缓存命中）。
 *
 * 这一组盯四件事：分类对不对、映射覆不覆盖得住、层真的进了系统提示且在稳定区、
 * 以及「首轮锁定」这条线真的接对了（拿第一条消息，不是最后一条）。
 */

import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, contextDiagCore, join, modeRouterCore, promptStackCore, readFileSync, require } from '../env.mjs'

export async function run() {
  group('CE-005 / persona 分类（纯正则）')
  check('研究类 → 强档', modeRouterCore.personaFor('查一下最新的资料').persona === 'strong')
  check('分析/规划 → 强档', modeRouterCore.personaFor('为什么会这样，分析一下').persona === 'strong')
  check('多步实现 → 强档', modeRouterCore.personaFor('帮我完成这个重构').persona === 'strong')
  check('问候 → 快档', modeRouterCore.personaFor('你好').persona === 'fast')
  check('空消息 → 快档（低风险回退）', modeRouterCore.personaFor('').persona === 'fast')
  check('带出原 mode（诊断用）', modeRouterCore.personaFor('你好').mode === 'chat')
  check('手动指定 mode 也走同一映射', modeRouterCore.personaFor('你好', 'think').persona === 'strong')
  check('只返回 persona/mode/confidence/reason（不授予权限）', !Object.keys(modeRouterCore.personaFor('删掉所有文件', 'agent')).includes('permission'))

  /* ★ 映射必须覆盖 RULES 里出现的**每一个** mode —— 加了新 mode 忘了加映射，
     会静默回退 fast（强档任务被当快档，没人会发现）。 */
  const modes = [...new Set(modeRouterCore.RULES.map((rule) => rule.mode))]
  const missing = modes.filter((mode) => !(mode in modeRouterCore.MODE_PERSONA))
  check('★ MODE_PERSONA 覆盖每一个 mode（加了 mode 必须同步映射）', missing.length === 0, `缺：${missing.join(',')}`)
  check('兜底档在映射里（chat → fast）', modeRouterCore.MODE_PERSONA.chat === 'fast')

  group('CE-005 / persona 层进系统提示')
  check('ORDER 里有 personaGuide 层', promptStackCore.ORDER.includes('personaGuide'))
  const layers = promptStackCore.buildLayers({ personaGuide: promptStackCore.personaGuide('strong') })
  check('buildLayers 真的产出了 personaGuide 层', layers.some((l) => l.id === 'personaGuide' && l.content))
  check('★ persona 算稳定层（首轮锁定 → 吃缓存命中）', contextDiagCore.tierOf('personaGuide') === 'stable')
  check('强/快两档都有文案', promptStackCore.PERSONA_GUIDE.strong.length > 0 && promptStackCore.PERSONA_GUIDE.fast.length > 0)
  check('认不出的 persona → 空串（别注入空层）', promptStackCore.personaGuide('nope') === '')
  check('★ 提示词版本已升到 /7', promptStackCore.VERSION === 'prompt-stack/7')

  const text = promptStackCore.build({
    personaGuide: promptStackCore.personaGuide('strong'),
    workRules: promptStackCore.WORK_RULES,
  }).message.content
  check('提示里有 Persona 层标题', text.includes('## Persona'))
  check('顺序：persona 在 Conversation Policy 之后', text.indexOf('Conversation Policy') < text.indexOf('## Persona'))
  check('顺序：persona 在 How To Work 之前', text.indexOf('## Persona') < text.indexOf('## How To Work'))

  group('CE-005 / 首轮锁定接线')
  const promptSrc = readFileSync(join(ROOT, 'electron/core/loop-prompt.cjs'), 'utf8')
  check('★ loop-prompt 真的把 personaGuide 传下去了', /^\s*personaGuide:\s*personaGuide\(/m.test(promptSrc))
  const routeSrc = readFileSync(join(ROOT, 'electron/core/loop-route.cjs'), 'utf8')
  check('★ 取的是**第一条**用户消息（不是最后一条）', /function firstUserText/.test(routeSrc))
  const routerSrc = readFileSync(join(ROOT, 'electron/core/mode-router.cjs'), 'utf8')
  check('★ 分类器保持纯正则：不 require 任何东西（没有 LLM / 网络）', !/require\(/.test(routerSrc))

  /* ★ 行为级（不是源码守卫）：真跑一遍取词与锁定 */
  const loopRoute = require(join(ROOT, 'electron/core/loop-route.cjs'))
  check(
    'firstUserText 跳过 system 消息',
    loopRoute.firstUserText([{ role: 'system', content: 'x' }, { role: 'user', content: '重构' }]) === '重构',
  )
  check(
    'firstUserText 跳过数组内容（带图消息）',
    loopRoute.firstUserText([{ role: 'user', content: [{ type: 'image' }] }, { role: 'user', content: '改英文' }]) === '改英文',
  )
  check(
    '★ 首轮锁定：后面的话说了快档词汇，persona 不变',
    loopRoute.personaOf([{ role: 'user', content: '帮我完成这个重构' }, { role: 'user', content: '你好' }]).persona === 'strong',
  )

  /* ★ 端到端：真调一次 buildPromptContext，从**最终系统提示**里找 persona 文案 ——
     CE-001 的教训就是「每一块单独测都绿、就是没人把它传下去」，所以这一步必须有。
     不传 sessionId / taskId ⇒ 不写任何快照与台账（自检不碰用户数据）。 */
  const { buildPromptContext } = require(join(ROOT, 'electron/core/loop-prompt.cjs'))
  const systemFor = (messages, extra = {}) =>
    String(
      buildPromptContext({
        config: { assistant: { name: 'Agent', maxTokens: 1000 }, tools: { permission: 'ask' } },
        workdir: SANDBOX,
        mode: 'pair',
        history: messages,
        threadSettings: {},
        options: { history: messages, traceId: 'selftest-persona', ...extra },
      })?.messages?.[0]?.content ?? '',
    )
  const strongText = systemFor([{ role: 'user', content: '帮我重构整个鉴权模块' }])
  const fastText = systemFor([{ role: 'user', content: '你好' }])
  check('★ 端到端：首轮「重构」→ 系统提示里出现强档文案', strongText.includes('强档'))
  check('★ 端到端：首轮「你好」→ 系统提示里出现快档文案', fastText.includes('快档') && !fastText.includes('强档'))
  check(
    '★ 端到端：首轮锁定（第二轮说「你好」也不翻档）',
    systemFor([
      { role: 'user', content: '帮我重构整个鉴权模块' },
      { role: 'assistant', content: '好' },
      { role: 'user', content: '你好' },
    ]).includes('强档'),
  )

  /* ══ CE-005 · 长会话：传给循环的 history 是 historyLimit 截过的窗口 ══
     真实 bug（写这组时发现并修的）：chat.cjs 给循环的 history = `rawHistory.slice(-limit)`
     （默认 20 条）。长会话里第一条用户消息会被**滑走** → `firstUserText(窗口)` 每轮都变
     → persona 中途翻档（既违背「首轮锁定」，也把稳定前缀缓存打掉）。
     修法：chat.cjs 另外把**完整** payload 传下来（`fullHistory`），只给 persona 用。
     下面这条是它变红才会被发现的回归测试。 */
  group('CE-005 / 长会话：完整 payload（不被截窗滑走）')
  const chatSrc = readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8')
  check('★ chat.cjs 把完整 payload 传下去（fullHistory: rawHistory）', /fullHistory:\s*rawHistory/.test(chatSrc))
  check('★ loop-prompt 优先用 fullHistory', /personaOf\(options\?\.fullHistory/.test(promptSrc))

  const longHistory = [
    { role: 'user', content: '帮我重构整个鉴权模块' },
    ...Array.from({ length: 23 }, (_, i) => ({ role: 'user', content: `闲聊第 ${i} 句` })),
    { role: 'user', content: '你好' },
  ]
  check(
    '★ 前提：截窗后第一条确实被滑走（不然这条测试没意义）',
    loopRoute.firstUserText(longHistory) !== loopRoute.firstUserText(longHistory.slice(-20)),
  )
  check(
    '★ 带完整 payload → persona 跟**第一条**（强档）',
    systemFor(longHistory.slice(-20), { fullHistory: longHistory }).includes('强档'),
  )
  check(
    '★ 只给窗口 → 跟窗口第一条走（证明这份 payload 是必要的）',
    !systemFor(longHistory.slice(-20)).includes('强档'),
  )
  check(
    '★ 子代理：只给 history 时按它自己那条判（不读会话文件、不继承父档）',
    systemFor([{ role: 'user', content: '帮我重构这个模块' }]).includes('强档'),
  )

  group('CE-006 / strictMode 接口预留（批次 3 才实施）')
  check(
    '★ 默认关：开了也等于没开（本批次不实施严格模式）',
    promptStackCore.workRules({ strictMode: true }) === promptStackCore.WORK_RULES,
  )
}
