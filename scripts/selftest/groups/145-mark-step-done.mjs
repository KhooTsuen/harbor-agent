import { join, require, ROOT, SANDBOX, disposeTasks, readFileSync, ctx as baseCtx } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   打卡工具 mark_step_done（2026-10-13）

   症结：计划卡上的 `[ ]` 由模型维护，而模型只在每轮第 1 个 LLM 轮次输出正文
   （计划块在里面），后续工具轮没有正文 → `[x]` 永远不亮。这个工具让模型在工具轮
   也能打卡。设计：docs/research/mark-step-done-design.md。

   要钉死的事实：
     · **两处同步** —— task.plan 与 planVersions[last].plan 都要变（PlanCard 读后者）；
     · **幂等** —— 已打卡的步骤不重复写盘；
     · **越界不抛异常** —— 返回错误文本让模型纠正（抛了会炸掉模型循环）；
     · **不算写操作** —— 不进 WRITE_TOOLS；
     · **不许骗门禁** —— 只打卡不跑命令，严格模式照样拦（判据是 plan 里的 [x]）；
     · **指纹忽略勾选** —— 打卡不再误报「计划正文与批准时不一致」；
       同时**版本变更仍看全文** —— 仅勾选变化也要落盘（否则门禁/进度倒退检测失效）。
   ══════════════════════════════════════════════════════════════ */

const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const taskPlan = require(join(ROOT, 'electron/core/task-plan.cjs'))
const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))
const registry = require(join(ROOT, 'electron/core/tools/registry.cjs'))
const taskStrict = require(join(ROOT, 'electron/core/task-strict.cjs'))

export async function run() {
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
  const created = []
  const markCtx = (taskId) => ({ ...baseCtx, taskId, sessionId: 'selftest-mark' })

  const t = taskCore.create({ goal: '打卡工具测试', sessionId: 'selftest-mark' })
  created.push(t.id)
  taskCore.setPlan(t.id, ['[ ] 一', '[ ] 二', '[ ] 三'])

  group('打卡 / 正常打卡：plan 与 planVersions 同步')
  const out = await tools.execute('mark_step_done', { step_index: 0 }, markCtx(t.id))
  check('返回「已打卡」', String(out).includes('已打卡'), String(out).slice(0, 60))
  check('★ task.plan 勾上了', taskCore.get(t.id).plan[0] === '[x] 一', taskCore.get(t.id).plan[0])
  check(
    '★ planVersions[last].plan 也勾上了（PlanCard 读的就是它）',
    taskCore.get(t.id).planVersions.at(-1).plan[0] === '[x] 一',
    taskCore.get(t.id).planVersions.at(-1).plan[0],
  )
  check('进度到 1/3', taskPlan.progressOf(taskCore.get(t.id).plan).done === 1)
  check('nextAction 跟着走到「二」', taskCore.get(t.id).nextAction === '二', taskCore.get(t.id).nextAction)

  group('打卡 / 幂等（已打卡不重复写盘）')
  const again = await tools.execute('mark_step_done', { step_index: 0 }, markCtx(t.id))
  check('重复打卡说「已经打过卡」', String(again).includes('已经打过卡'), String(again).slice(0, 60))
  check('进度没被重复加', taskPlan.progressOf(taskCore.get(t.id).plan).done === 1)

  group('打卡 / 越界不抛异常')
  const oob = await tools.execute('mark_step_done', { step_index: 9 }, markCtx(t.id))
  check('越界返回错误文本（不抛）', String(oob).includes('超出范围'), String(oob).slice(0, 40))
  check('越界没改动计划', taskPlan.progressOf(taskCore.get(t.id).plan).done === 1)
  const neg = await tools.execute('mark_step_done', { step_index: -1 }, markCtx(t.id))
  check('负下标也拦', String(neg).includes('超出范围'), String(neg).slice(0, 40))
  const nonInt = await tools.execute('mark_step_done', { step_index: 1.5 }, markCtx(t.id))
  check('非整数被参数校验拦下', String(nonInt).includes('整数'), String(nonInt).slice(0, 40))

  group('打卡 / 与 strictMode 协同：只打卡不验证照样被拦')
  const s = taskCore.create({ goal: '打卡不能骗门禁', sessionId: 'selftest-mark' })
  created.push(s.id)
  taskCore.setPlan(s.id, ['[ ] 第一步', '[ ] 第二步'])
  taskCore.addStep(s.id, { tool: 'edit_file', ok: true, summary: '改文件' })
  taskCore.addStep(s.id, { tool: 'run_shell', ok: true, summary: '开工后跑过一次' })
  /* 让中途门禁先「看见」这条任务（建立观察锚） */
  taskStrict.strictGate({ taskId: s.id, enabled: true })
  await tools.execute('mark_step_done', { step_index: 0 }, markCtx(s.id))
  const pend = taskStrict.strictGate({ taskId: s.id, enabled: true })
  check('★ 只打卡、没再跑命令 → 严格模式顶回', pend.message.includes('严格模式'), pend.message.slice(0, 50))

  group('打卡 / 指纹忽略勾选（不再误报「正文与批准时不一致」）')
  check('指纹忽略勾选', taskPlan.fingerprint(['[x] a']) === taskPlan.fingerprint(['[ ] a']))
  const tt = taskCore.create({ goal: '指纹', sessionId: 'selftest-mark' })
  created.push(tt.id)
  taskCore.setPlan(tt.id, ['[ ] x', '[ ] y'])
  const hashBefore = taskCore.get(tt.id).planHash
  await tools.execute('mark_step_done', { step_index: 0 }, markCtx(tt.id))
  check(
    '★ 打卡后 planHash 仍等于 fingerprint(plan)（注入层不会误报）',
    taskCore.get(tt.id).planHash === taskPlan.fingerprint(taskCore.get(tt.id).plan) &&
      taskCore.get(tt.id).planHash === hashBefore,
  )

  group('打卡 / 版本变更仍看全文（不回归：仅勾选变化也要落盘）')
  const v = taskCore.create({ goal: '版本', sessionId: 'selftest-mark' })
  created.push(v.id)
  taskCore.setPlan(v.id, ['[ ] a', '[ ] b'])
  const rv = taskCore.setPlan(v.id, ['[x] a', '[ ] b'])
  check('★ 仅勾选变化仍记新版本', rv.changed === true)
  check('新版本那条是 [x]', taskCore.get(v.id).planVersions.at(-1).plan[0] === '[x] a')

  group('打卡 / 接线守卫（防「写好了没人调 / 放错了名单」）')
  check('★ mark_step_done 已注册进 ALL', registry.ALL.some((x) => x.name === 'mark_step_done'))
  check(
    '★ mark_step_done **不在** WRITE_TOOLS（否则每步弹确认框）',
    !registry.WRITE_TOOLS.has('mark_step_done'),
  )
  check(
    '★ 工具 schema 真的送到模型面前（toApiSchema 里有它）',
    tools.toApiSchema().some((t) => t.function.name === 'mark_step_done'),
  )
  const toolSrc = read('electron/core/tools/mark_step_done.cjs')
  check(
    '★ 内核落点是 task-plan（硬禁区 8：没碰 task.cjs）',
    toolSrc.includes("'../task-plan.cjs'") && !toolSrc.includes("'../task.cjs'"),
  )
  check('★ 落盘走 task-io.write（= writeAtomic）', toolSrc.includes('io.write(task)'))

  disposeTasks(created)
  check('测试任务已清理', created.every((id) => taskCore.get(id) === null))
}
