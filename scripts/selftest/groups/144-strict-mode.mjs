/**
 * 自检 / CE-008 严格模式（Phase 6 批次 3）
 *
 * 把批次 1/2 的**软约束**升级为「基于内核结构化事实的硬门禁」：
 * 判据只读 `task.steps` 的结构化事件与计划勾选数（`task-strict.cjs`），
 * 不用正则解析模型自然语言、也不猜「计划第 N 条对应哪个工具」。
 *
 *   · 中途（每轮工具跑完）：每累计 3 次写操作 / 每勾掉一条计划且没验证 → 顶回；
 *   · 收尾：有未验证的写操作 → 不许收工（shouldContinue）；
 *           计划勾了但没验证 → 不许收工（shouldVerify）。
 *
 * 本组重点：**开 / 关对比** —— 同一串台账，strictMode 开 = 拦截、关 = 放行；
 * 以及「默认关时行为与升级前一字不差」。
 */

import { check, group } from '../harness.mjs'
import { ROOT, disposeTasks, join, promptStackCore, readFileSync, require } from '../env.mjs'

const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const taskSteering = require(join(ROOT, 'electron/core/task-steering.cjs'))
const taskStrict = require(join(ROOT, 'electron/core/task-strict.cjs'))
const { normalize } = require(join(ROOT, 'electron/core/config-normalize.cjs'))

export async function run() {
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
  const created = []

  /* ── 造一条「3 次写、没跑命令」的台账 ── */
  const t = taskCore.create({ goal: '严格模式对比测试', sessionId: 'selftest-strict' })
  created.push(t.id)
  for (let i = 0; i < 3; i += 1) {
    taskCore.addStep(t.id, { tool: 'edit_file', ok: true, summary: `改第 ${i + 1} 个文件` })
  }

  group('CE-008 / 开 vs 关：同一串台账，两种结果')
  check(
    '★ 关闭时正常放行（不拦）',
    taskSteering.shouldContinue({ taskId: t.id, seen: {}, strictMode: false }).continue === false,
  )
  const on = taskSteering.shouldContinue({ taskId: t.id, seen: {}, strictMode: true })
  check('★ 开启时拦截：有写操作但没跑命令 → 不许收工', on.continue === true)
  check('★ 拦截话术带【严格模式】、说清欠了什么', on.message.startsWith('【严格模式】'), on.message.slice(0, 80))

  group('CE-008 / 中途门禁（每累计 3 次写操作）')
  check('关闭：中途一句话都不说', taskStrict.strictGate({ taskId: t.id, enabled: false }).message === '')
  const mid = taskStrict.strictGate({ taskId: t.id, enabled: true })
  check('★ 开启：累计 3 次写没验证 → 顶回一句', mid.message.startsWith('【严格模式】'), mid.message.slice(0, 80))
  check('同一条欠账只顶一次（刹车）', taskStrict.strictGate({ taskId: t.id, enabled: true }).message === '')

  group('CE-008 / 跑了命令 → 欠账清零')
  taskCore.addStep(t.id, { tool: 'run_shell', ok: true, summary: 'npm test' })
  check(
    '★ 验证之后收尾放行',
    taskSteering.shouldContinue({ taskId: t.id, seen: {}, strictMode: true }).continue === false,
  )
  check('★ 验证之后中途也放行', taskStrict.strictGate({ taskId: t.id, enabled: true }).message === '')
  check('纯函数：backlog 清零', taskStrict.strictBacklog(taskCore.get(t.id)) === 0)

  group('CE-008 / 计划勾了但没验证（收尾欠账）')
  const p = taskCore.create({ goal: '计划勾选欠账', sessionId: 'selftest-strict' })
  created.push(p.id)
  taskCore.setPlan(p.id, ['[ ] 第一步', '[ ] 第二步'])
  taskCore.addStep(p.id, { tool: 'edit_file', ok: true, summary: '改一个文件' })
  taskCore.addStep(p.id, { tool: 'run_shell', ok: true, summary: '开工后先跑了一次' })
  /* 让中途门禁先「看见」这条任务（建立观察锚：命令数 1 / 勾选数 0） */
  taskStrict.strictGate({ taskId: p.id, enabled: true })
  /* 模型重发计划、勾掉一条 —— 但勾完之后没再跑过命令 */
  taskCore.setPlan(p.id, ['[x] 第一步', '[ ] 第二步'])
  check(
    '关闭时：普通验证门禁不拦（已经跑过命令）',
    taskSteering.shouldVerify({ taskId: p.id, seen: {}, strictMode: false }).continue === false,
  )
  const pend = taskSteering.shouldVerify({ taskId: p.id, seen: {}, strictMode: true })
  check('★ 开启时：计划勾了没验证 → 拦截', pend.continue === true)
  check(
    '★ 也说清了欠的是「勾计划后没验证」',
    pend.message.includes('严格模式') && pend.message.includes('勾掉'),
    pend.message.slice(0, 80),
  )

  group('CE-008 / 提示词层（workRules）')
  check('默认关：输出与老一致（WORK_RULES）', promptStackCore.workRules({}) === promptStackCore.WORK_RULES)
  check('打开：注入「严格模式」那一条', promptStackCore.workRules({ strictMode: true }).includes('严格模式'))
  check(
    '其余规矩一条不少（增的是那一条，不是换整层）',
    promptStackCore.workRules({ strictMode: true }).includes('先看再改'),
  )

  group('CE-008 / 配置（默认 + 归一化）')
  check('默认值：assistant.strictMode = false（关）', normalize({}).assistant.strictMode === false)
  check('归一化：显式 true 保留', normalize({ assistant: { strictMode: true } }).assistant.strictMode === true)
  check('归一化：脏值（字符串 yes）→ false', normalize({ assistant: { strictMode: 'yes' } }).assistant.strictMode === false)

  group('CE-008 / 接线守卫（防「写好了没人调」）')
  check('★ prompt-rules 真正读 strictMode 参数', read('electron/core/prompt-rules.cjs').includes('input.strictMode === true'))
  check(
    '★ loop-prompt 把配置传进 workRules',
    read('electron/core/loop-prompt.cjs').includes('strictMode: config.assistant?.strictMode'),
  )
  check(
    '★ 收尾门禁读结构化事实（strictBacklog / strictPlanPending）',
    read('electron/core/task-steering.cjs').includes('strict.strictBacklog') &&
      read('electron/core/task-steering.cjs').includes('strict.strictPlanPending'),
  )
  check(
    '★ 中途门禁接在工具执行器上（tool-runner 每轮调用）',
    read('electron/core/tool-runner.cjs').includes('taskStrict.pushStrictNote'),
  )
  check(
    '★ 判据只认结构化事件（write_file / edit_file / run_shell），不碰自然语言',
    read('electron/core/task-strict.cjs').includes("new Set(['write_file', 'edit_file'])") &&
      read('electron/core/task-strict.cjs').includes("=== 'run_shell'"),
  )
  check('★ 配置默认关（config-defaults）', read('electron/core/config-defaults.cjs').includes('strictMode: false'))
  check(
    '★ 归一化存在（补丁不会被静默丢掉）',
    read('electron/core/config-normalize.cjs').includes('strictMode: assistant.strictMode === true'),
  )
  check(
    '★ 设置界面有入口（能开也能关）',
    read('src/components/settings/providers/AssistantSwitches.tsx').includes('strictMode'),
  )
  check('★ 渲染层类型有声明', read('src/types/models.ts').includes('strictMode'))

  disposeTasks(created)
  check(
    '测试任务已清理',
    created.every((id) => taskCore.get(id) === null),
  )
}
