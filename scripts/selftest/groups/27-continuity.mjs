import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   AG-018：任务连续性

   文档说用户讲「继续 / 然后呢 / 继续改 / 接着做 / 还是刚才那个问题」时，
   Agent 要结合 Current Task + Conversation State + Last Action + Pending Step
   + Recent Tool Results 判断「这是在让我接着干，还是新活儿」。

   前四样 `task-context.cjs` 早就有了（计划进度、最近一步、改过的文件…），
   缺的是**认出「这句话是在说继续」**，然后把话说死，免得模型把「继续」
   当成一个含糊的新要求 —— 重新问一遍背景，或者重头讲一遍计划。

   ★ 这一条的风险全在**误判**上：把新任务当成「继续」比漏判糟糕得多
     （用户得再解释一遍，而 Agent 已经开始埋头干旧的）。
     所以宁可漏判也不要误判 —— 用例里特意放了几个反例。
   ══════════════════════════════════════════════════════════════ */

const taskContext = require(join(ROOT, 'electron/core/task-context.cjs'))

const readCore = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  group('AG-018 · 任务连续性')

  /* ── 文档点名的五种，必须认出来 ── */
  for (const phrase of ['继续', '然后呢', '继续改', '接着做', '还是刚才那个问题']) {
    check(`认得出「${phrase}」`, taskContext.isContinueIntent(phrase) === true)
  }
  check('「接着干吧」也认得出', taskContext.isContinueIntent('接着干吧') === true)
  check('英文 continue 也认', taskContext.isContinueIntent('go on') === true)
  check('句尾标点不影响', taskContext.isContinueIntent('继续。') === true)

  /* ── ★ 反例：这些是**新任务**，不能判成继续 ── */
  check(
    '★「继续优化 Agent 执行系统」是新任务（不是「继续」）',
    taskContext.isContinueIntent('继续优化 Agent 执行系统') === false,
  )
  check(
    '★ 长句子一律当新要求',
    taskContext.isContinueIntent('接着把刚才那个模块重构一下，另外还要加上日志和错误处理') ===
      false,
  )
  check('无关的话不认', taskContext.isContinueIntent('帮我写一个登录页面') === false)
  check('空串不认', taskContext.isContinueIntent('') === false)
  check('undefined 不炸', taskContext.isContinueIntent(undefined) === false)

  /* ── 注入 ── */
  const note = taskContext.buildTaskState({ userText: '继续' })
  /*
   * 没有未完成任务时不造台账；但**新活的第一轮**要把本轮请求带上 ——
   * AG-027 的任务名（`# 名字`）就靠它，只写通用规矩模型不照做（见 30-taskname）。
   */
  check('没有未完成任务时不造台账', !note.includes('还没做完'))
  check('★ 但会带上本轮请求（新活第一轮）', note.includes('本轮请求'))

  const src = readCore('electron/core/task-context.cjs')
  check('★ 认出「继续」后会明说「这是接着做，不是新任务」', src.includes('不是新任务'))
  check('★ 并且明确「别从头再问一遍」', src.includes('别从头再问一遍'))
  check('提示挂在 taskState 里（和计划进度同一处）', src.includes('isContinueIntent(userText)'))

  /* ── 接线 ── */
  const chatSrc = readCore('electron/handlers/chat.cjs')
  check(
    '★ chat.cjs 把用户那句话交给了 buildTaskState',
    chatSrc.includes('userText: lastUserText(history)'),
  )
  check('并且导出了 isContinueIntent', taskContext.isContinueIntent !== undefined)

  /* ── 「15 字」这条线是有来由的（真机调出来的） ── */
  check('★ 长度限制是收紧过的（30 字太松会把新要求当成继续）', src.includes('length > 15'))
}
