/**
 * 自检 / ②-2 按任务类型的推荐参数
 *
 * 清单里这一条原本是：
 *   ❌「按任务类型预设推荐参数（温度 0.1–0.3 / 最大轮数 / 工具调用上限）—— 没做。
 *      现在是一套全局默认（assistant.temperature = 0.7、budget.maxSteps = 50）」
 *
 * 三条要守住的：
 *   ① 判定复用意图路由的规则，不另写一套关键词（两处不一致最难查）
 *   ② **认不出来就别乱给** —— 兜底成 chat 是「没法判断」，不是「判断出是闲聊」
 *   ③ 用户自己调过全局预算就**不插手**
 */

import { check, group } from '../harness.mjs'
import { disposeTasks, join, readFileSync, require, ROOT, taskCore } from '../env.mjs'

export async function run() {
  const presets = require(join(ROOT, 'electron/core/task-presets.cjs'))
  const resumeCore = require(join(ROOT, 'electron/core/task-resume.cjs'))

  group('②-2 / 一张类型表')
  check('六种类型都在', Object.keys(presets.TYPES).length === 6, Object.keys(presets.TYPES).join(','))
  check('★ 写代码给低温度（要确定性）', presets.TYPES.code.temperature <= 0.3)
  check('★ 创作给高温度（要发散）', presets.TYPES.creative.temperature >= 0.8)
  check(
    '★ 每种都写了「为什么」—— 界面要显示理由，不是甩几个数字',
    Object.values(presets.TYPES).every((item) => String(item.why).length >= 8),
  )
  check(
    '★ 除闲聊/创作外，预设不会比全局默认（50 / 100）更紧 —— 预设不该让人更容易撞墙',
    Object.entries(presets.TYPES)
      .filter(([key]) => key !== 'chat' && key !== 'creative')
      .every(([, item]) => item.maxSteps >= 50 && item.maxToolCalls >= 100),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(presets.TYPES).map(([k, v]) => [k, `${v.maxSteps}/${v.maxToolCalls}`]),
      ),
    ),
  )

  group('②-2 / 认得出是哪类活')
  check('「帮我搜一下最新的 React 版本」→ 查资料', presets.detect('帮我搜一下最新的 React 版本').type === 'research')
  check('「这段代码为什么报错」→ 写代码', presets.detect('这段代码为什么报错').type === 'code')
  check('「帮我写个文案」→ 创作', presets.detect('帮我写个文案').type === 'creative')
  check('「实现一个登录页」→ 多步执行', presets.detect('实现一个登录页').type === 'agent')
  const blank = presets.detect('今天天气怎么样')
  check('★ 认不出来要说认不出来（guessed）', blank.guessed === true, JSON.stringify(blank))
  check(
    '手动指定优先',
    presets.detect('你好', 'code').type === 'code' && presets.detect('你好', 'code').guessed === false,
  )

  group('②-2 / 预算建议')
  check(
    '★ 认不出来就给空对象（不拿猜测去压用户的设置）',
    Object.keys(presets.budgetFor('今天天气怎么样', {})).length === 0,
  )
  const codeBudget = presets.budgetFor('这段代码为什么报错', {})
  check('★ 代码活给到轮数 50 / 工具 100', codeBudget.maxSteps === 50 && codeBudget.maxToolCalls === 100, JSON.stringify(codeBudget))
  check(
    '★ 用户自己调过预算就不插手 —— 他调那个数字是有原因的',
    Object.keys(presets.budgetFor('这段代码为什么报错', { agent: { budget: { maxSteps: 200 } } }))
      .length === 0,
  )
  check(
    '用户只调了别的项（比如 token）也照样不插手',
    Object.keys(presets.budgetFor('这段代码为什么报错', { agent: { budget: { maxTokens: 5 } } })).length === 0,
  )

  group('②-2 / 温度取值')
  check('对话级优先', presets.temperatureOf({ temperature: 0.1 }, { assistant: { temperature: 0.7 } }) === 0.1)
  check(
    '★ 温度 0 也算数（用 `||` 会把它吞掉换成全局值）',
    presets.temperatureOf({ temperature: 0 }, { assistant: { temperature: 0.7 } }) === 0,
  )
  check('没设就用全局', presets.temperatureOf({}, { assistant: { temperature: 0.9 } }) === 0.9)
  check('越界回退到全局（不把 5 传给模型）', presets.temperatureOf({ temperature: 5 }, { assistant: { temperature: 0.9 } }) === 0.9)
  check('两边都没有时给 0.7', presets.temperatureOf({}, {}) === 0.7)

  group('②-2 / 端到端：新建任务真的带上')
  const made = []
  try {
    const presetTask = resumeCore.openForRun({
      goal: '这段代码为什么报错',
      sessionId: 'selftest-02-2a',
      config: {},
    })
    made.push(presetTask.id)
    check('★ 新任务的预算来自预设', presetTask.budget.maxSteps === 50, JSON.stringify(presetTask.budget))
    check('★ 台账记着「哪来的」（用户看到 60/120 要追得到原因）', presetTask.preset === 'code', presetTask.preset)

    const plainTask = resumeCore.openForRun({
      goal: '今天天气怎么样',
      sessionId: 'selftest-02-2b',
      config: {},
    })
    made.push(plainTask.id)
    check(
      '★ 认不出来就一个字都不写（沿用用户设置）',
      Object.keys(plainTask.budget ?? {}).length === 0 && plainTask.preset === '',
      JSON.stringify({ budget: plainTask.budget, preset: plainTask.preset }),
    )

    const diagnoseCore = require(join(ROOT, 'electron/core/task-diagnose.cjs'))
    const text = String(diagnoseCore.diagnose(presetTask).text)
    check('★ 诊断报告里说清预算来源', text.includes('预算来源：按「写代码」'), text.split('\n').filter((l) => l.startsWith('预算来源')).join(' / '))
  } finally {
    /* ★ 用 disposeTasks：这两个任务建出来就是 running，removeSafe 删不掉（见 env.mjs） */
    const left = disposeTasks(made)
    check('测试建的任务都删干净了', left.length === 0, left.join(','))
  }

  group('②-2 / 接线')
  const loopSrc = readFileSync(join(ROOT, 'electron/core/loop.cjs'), 'utf8')
  check(
    '★ 循环用的是「对话级温度」（不是直接读全局）',
    loopSrc.includes('taskPresets.temperatureOf(threadSettings, config)'),
  )
  const resumeSrc = readFileSync(join(ROOT, 'electron/core/task-resume.cjs'), 'utf8')
  check('★ 建任务时给了预算', resumeSrc.includes('taskPresets.budgetFor(goal, options.config)'))
}
