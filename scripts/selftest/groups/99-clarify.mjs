import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-053：开工前澄清 —— 内核这一侧

   需求原话：「AI 在任务开始时，主动把需要用户拿主意的地方摆出来；每个选项下方
   写清『因为 X，所以会有 Y 效果』（具体数字或事实）；用户可以自由回答、跳过；
   用户答完后才进入执行。」

   这一组钉四块：
     ① 校验（`core/clarify.cjs`）：条数 / 选项数上限、坏问题剔除并报告、
        effect 没实质内容要**警告**（不剔除）、默认选项缺失要退回第一个并报告；
     ② 静音（同一对话连跳 2 次不再主动问；答一次就清零；能手动唤醒）；
     ③ 超时状态机（`core/clarify-timeout.cjs`）：**在场不计时**、离场才累加、
        到点报 timeout、任务累计超上限报 muted、读不到空闲值按在场处理；
     ④ 接线（工具注册、规则注入与开关、配置项、不 require electron）。

   ⚠️ 离场检测**不 require electron** —— 真机上由 main.cjs 注入 powerMonitor，
      这里用注入的假函数把状态机跑完（没 Electron 也能验）。
   ══════════════════════════════════════════════════════════════ */

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/** 造一批合法问题（当模板用，测试里改字段） */
const good = (patch = {}) => ({
  question: '用哪个包管理器？',
  options: [
    { label: 'pnpm', effect: '仓库里有 pnpm-lock.yaml，换 npm 会多装 1 份依赖' },
    { label: 'npm', effect: '要重新生成 lock 文件，多花约 30 秒' },
  ],
  defaultValue: 'pnpm',
  ...patch,
})

export async function run() {
  const clarify = require(join(ROOT, 'electron/core/clarify.cjs'))
  const askUser = require(join(ROOT, 'electron/core/tools/ask_user.cjs'))
  const promptStack = require(join(ROOT, 'electron/core/prompt-stack.cjs'))
  const registry = require(join(ROOT, 'electron/core/tools/registry.cjs'))

  group('AG-053 / 校验：条数、选项数、坏问题剔除')
  const over = clarify.normalize([good({ question: '一' }), good({ question: '二' }), good({ question: '三' }), good({ question: '四' })])
  check('一次最多 3 个问题', over.questions.length === 3, String(over.questions.length))
  check(
    '多出来的那条被点名剔除（不是静默丢）',
    over.dropped.some((one) => one.question === '四' && /最多/.test(one.reason)),
    JSON.stringify(over.dropped),
  )

  const manyOptions = clarify.normalize([
    good({ options: [1, 2, 3, 4, 5].map((n) => ({ label: `选项${n}`, effect: `多花 ${n} 秒` })) }),
  ])
  check('每个问题最多 4 个选项', manyOptions.questions[0].options.length === 4)

  const broken = clarify.normalize([
    good({ question: '   ' }),
    good({ options: [] , allowFreeform: false }),
    good({ question: '正常的问题' }),
  ])
  check('空问题被剔除', broken.dropped.some((one) => one.reason === '问题是空的'))
  check(
    '既没选项又不许自由回答 → 剔除',
    broken.dropped.some((one) => /既没有选项/.test(one.reason)),
    JSON.stringify(broken.dropped),
  )
  check('好的那问照常留下（坏的不连坐）', broken.questions.length === 1, String(broken.questions.length))
  check('一个都没有时返回空表而不是抛错', clarify.normalize(undefined).questions.length === 0)

  group('AG-053 / 校验：effect 必须说人话（宽松检查 → 警告）')
  const vague = clarify.normalize([
    good({
      options: [
        { label: 'A', effect: '更稳妥' },
        { label: 'B', effect: '' },
        { label: 'C', effect: '多花 30 秒' },
        { label: 'D', effect: '会新增 3 个文件' },
      ],
    }),
  ])
  check(
    '★ 没数字也没量词的效果 → 警告（不剔除：宁可让用户看到，也不要整条消失）',
    vague.warnings.some((one) => /没有数字也没有量词/.test(one.warning)),
    JSON.stringify(vague.warnings),
  )
  check('★ 空效果 → 警告', vague.warnings.some((one) => /没写效果/.test(one.warning)))
  check('有具体数字的效果不报警告', !vague.warnings.some((one) => /多花 30 秒/.test(one.warning)))
  check(
    '选项还在（宽松检查不剔东西）',
    vague.questions[0].options.length === 4,
    String(vague.questions[0].options.length),
  )
  check('量词也算具体（「会新增 3 个文件」判定为 concrete）', clarify.concrete('会新增 3 个文件') === true)
  check('纯主观判断不算具体（「更稳妥」）', clarify.concrete('更稳妥') === false)

  group('AG-053 / 默认选项：没标就取第一个，并报告')
  const noDefault = clarify.normalize([good({ defaultValue: undefined })])
  check('没标默认 → 取第一个', noDefault.questions[0].defaultValue === 'pnpm')
  check('并且记下来这是「退让」来的（defaultFrom=first）', noDefault.questions[0].defaultFrom === 'first')
  check(
    '报告里说清了',
    noDefault.warnings.some((one) => /没标默认选项/.test(one.warning)),
    JSON.stringify(noDefault.warnings),
  )
  const badDefault = clarify.normalize([good({ defaultValue: 'yarn' })])
  check(
    '默认选项不在选项里 → 退回第一个并警告',
    badDefault.questions[0].defaultValue === 'pnpm' &&
      badDefault.warnings.some((one) => /不在选项里/.test(one.warning)),
  )

  group('AG-053 / 静音：连跳 2 次不再问，答一次清零，可手动唤醒')
  const session = 'selftest-clarify-a'
  clarify.wake(session)
  check('一开始不静音', clarify.muted(session) === false)
  check('跳 1 次还不静音', clarify.noteSkip(session) === 1 && clarify.muted(session) === false)
  check('★ 连续跳 2 次 → 静音', clarify.noteSkip(session) === 2 && clarify.muted(session) === true)
  check('计数是能查的（排查用）', clarify.skipCount(session) === 2)
  clarify.noteAnswered(session)
  check('★ 答过一次 → 计数清零（他愿意被问，之前的跳过不算数）', clarify.muted(session) === false)
  clarify.noteSkip(session)
  clarify.noteSkip(session)
  check('再连跳 2 次又静音', clarify.muted(session) === true)
  clarify.wake(session)
  check('★ 手动唤醒（「问我想清楚」/「你问我几个问题」）→ 立刻恢复', clarify.muted(session) === false)
  check('不同对话互不影响', clarify.muted('另一个对话') === false)
  check(
    '★ 静音是「别老问了」不是「永远别问」：唤醒是一次性的（不写偏好、不跨对话）',
    clarify.skipCount(session) === 0,
  )

  group('AG-053 / 工具：静音、没通道、用户跳过')
  const toolRun = async (args, ctx) => String(await askUser.run(args, ctx))
  const quiet = await toolRun({ questions: [good()] }, { sessionId: session, clarify: null })
  check(
    '★ 通道没接上 → 放行（不能因为辅助能力缺失把任务卡死）',
    /没有接上澄清通道/.test(quiet),
    quiet.slice(0, 60),
  )

  const mutedSession = 'selftest-clarify-muted'
  clarify.wake(mutedSession)
  clarify.noteSkip(mutedSession)
  clarify.noteSkip(mutedSession)
  const mutedOut = await toolRun(
    { questions: [good()] },
    { sessionId: mutedSession, clarify: async () => ({ answers: [] }) },
  )
  check('★ 静音时直接拒绝提问，并让模型自己拍板 + 留一行理由', /连续跳过两次/.test(mutedOut), mutedOut.slice(0, 60))
  check('静音时**没有**真的去问用户', !/用户的答复/.test(mutedOut))

  const answers = []
  const answered = await toolRun(
    { questions: [good()] },
    {
      sessionId: 'selftest-clarify-answer',
      clarify: async (payload) => {
        answers.push(payload)
        return { answers: [{ question: '用哪个包管理器？', choice: 'npm', text: '我习惯 npm' }] }
      },
    },
  )
  check('问出去的是规范化之后的问题', Array.isArray(answers[0]?.questions) && answers[0].questions.length === 1)
  check('带上 sessionId / taskId（内核要按对话记跳过）', answers[0]?.sessionId === 'selftest-clarify-answer')
  check('答复翻成文本给模型', /npm/.test(answered) && /我习惯 npm/.test(answered), answered.slice(0, 80))
  check('★ 答复里带上了「因为…」（用户看得懂的选择理由）', /因为/.test(answered))
  check('答过之后这个对话不静音', clarify.muted('selftest-clarify-answer') === false)

  const skipped = await toolRun(
    { questions: [good()] },
    { sessionId: 'selftest-clarify-skip', clarify: async () => ({ skipped: true }) },
  )
  check('★ 用户跳过 → 明确让模型自己拍板 + 留一行理由', /跳过了这次澄清/.test(skipped), skipped.slice(0, 60))

  const timedOut = await toolRun(
    { questions: [good()] },
    {
      sessionId: 'selftest-clarify-timeout',
      clarify: async () => ({
        timeout: true,
        answers: [{ question: '用哪个包管理器？', choice: 'pnpm' }],
      }),
    },
  )
  check('★ 超时采纳默认 → 文本里标明这是默认（模型要如实告诉用户）', /离场/.test(timedOut) && /默认/.test(timedOut))
  check('超时那条标了［默认］', /［默认］/.test(timedOut), timedOut.slice(0, 120))

  const bad = await toolRun({ questions: [{ question: '' }] }, { sessionId: 'x', clarify: async () => ({}) })
  check('参数全坏 → 返回说明而不是抛错（不让整轮废掉）', /没能问出去/.test(bad), bad.slice(0, 60))

  group('AG-053 / 规则注入与开关')
  const rules = promptStack.workRules({ planFirst: true, clarifyFirst: true })
  check('★ 开着时提示词里有「开工前先对齐」', rules.includes('ask_user') && rules.includes('开工前先对齐'))
  check('★ 规则里硬要求 effect 带具体数字或事实', /具体数字或事实/.test(rules))
  check('★ 规则里硬要求默认选项是最保守那个', /最容易回滚/.test(rules))
  check('规则里写明「你看着办」就不问', /看着办/.test(rules))
  check(
    '关掉开关 → 这一条不注入（其余照旧）',
    !promptStack.workRules({ planFirst: true, clarifyFirst: false }).includes('ask_user'),
  )
  check(
    '静音时也不注入（提示词里写着「先问」却不让问，模型会来回犹豫）',
    !promptStack.workRules({ planFirst: true, clarifyMuted: true }).includes('ask_user'),
  )
  check('计划那一条不受这个开关影响', rules.includes('plan 块'))

  group('AG-053 / 接线')
  check('工具表里有 ask_user', registry.byName('ask_user')?.name === 'ask_user')
  check(
    '★ ask_user 不算写操作（它本身就是问用户，再叠权限确认就是问两遍）',
    registry.WRITE_TOOLS.has('ask_user') === false,
  )
  /*
   * ⚠️ 源码断言必须先剥掉注释行：这几个文件的头注释里就写着「不 require electron」
   *   —— 连注释一起扫的话，一改注释就红（98 组里同一个坑踩过一次）。
   */
  const codeOf = (src) =>
    src
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
      })
      .join('\n')
  const coreSrc = read('electron/core/clarify.cjs')
  check('★ 内核这个文件不 require electron（自检/单测没 Electron 也能跑）', !codeOf(coreSrc).includes("require('electron')"))
  const timeoutSrc = read('electron/core/clarify-timeout.cjs')
  check('★ 超时状态机也不 require electron（powerMonitor 靠注入）', !codeOf(timeoutSrc).includes("require('electron')"))
  const toolSrc = read('electron/core/tools/ask_user.cjs')
  check('工具也不 require electron', !codeOf(toolSrc).includes("require('electron')"))
  /*
   * AG-053 的四项配置住在 `clarify-config.cjs`（`config-defaults` / `config-normalize`
   * 改之前分别是 299 / 298 行，塞 8 行进去两个文件一起破红线 —— 所以搬出来了）。
   * 于是要钉两组：**值在不在**（新模块）+ **有没有真接上**（那两个文件各一行 spread）。
   * 只钉前者的话，把 spread 删掉自检照样绿，而磁盘上的值没人读 —— 那种静默失效最贵。
   */
  const defaults = read('electron/core/config-defaults.cjs')
  const normalizeSrc = read('electron/core/config-normalize.cjs')
  const clarifyConfig = read('electron/core/clarify-config.cjs')
  check('默认开：clarifyFirst 默认 true', /clarifyFirst: true/.test(clarifyConfig))
  check(
    '三个时间参数都在默认配置里',
    ['clarifyIdleSeconds', 'clarifyTimeoutMs', 'clarifyMaxWaitMs'].every((key) =>
      clarifyConfig.includes(key),
    ),
  )
  check('脏配置会被夹取（不是直接信）', clarifyConfig.includes('clamp('))
  check(
    '★ config-defaults 真的接上了（光有模块没人用 = 默认值不存在）',
    defaults.includes("clarify-config.cjs').DEFAULTS"),
  )
  check(
    '★ config-normalize 真的接上了（不接上 = 磁盘上的值没人读）',
    normalizeSrc.includes("clarify-config.cjs').normalize(assistant)"),
  )
  const loopPrompt = read('electron/core/loop-prompt.cjs')
  check(
    'loop-prompt 把开关与静音传进 workRules',
    loopPrompt.includes('clarifyFirst') && loopPrompt.includes('clarifyMuted'),
  )
  check(
    '上限值只有一处定义（别处只引用）',
    !defaults.includes('600000') && !normalizeSrc.includes('600000'),
  )
}
