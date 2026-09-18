import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   AG-004：计划版本历史 / Re-plan

   这一组盯的是「计划是活的」这件事。以前有两个洞：

   ① `setPlan` 直接覆盖 `task.plan` —— 计划改过之后，旧的那版就没了，
      事后看不出「为什么变成现在这样」；
   ② `loop.cjs` 用一个 `planParsed` 布尔量「只抓第一次」—— 模型后来
      重新规划（用户改了要求、或者发现路走不通）会被**静默丢弃**。

   现在：每一版计划按时间留下来（含当前版），没变不记；`loop` 每轮都
   把它交给 `capturePlan`，变没变由那边说了算。

   边界必须钉死的两条：
     · 模型每轮都会原样复述计划 → **没变绝不能记新版本**（否则刷几十版）
     · 老任务只有 `plan` 没有 `planVersions` → **读的时候补 v1，不落盘**
   ══════════════════════════════════════════════════════════════ */

const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const taskPlan = require(join(ROOT, 'electron/core/task-plan.cjs'))
const taskContext = require(join(ROOT, 'electron/core/task-context.cjs'))
const paths = require(join(ROOT, 'electron/core/paths.cjs'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run() {
  const created = []

  function newTask() {
    const task = taskCore.create({ goal: 'selftest-plan', sessionId: 'selftest-plan' })
    created.push(task.id)
    return task
  }

  /* ── ① 第一版 ─────────────────────────────────────────── */
  group('计划版本 / 第一版')
  const t1 = newTask()
  const v1 = taskCore.setPlan(t1.id, ['读配置', '改代码'])

  check('第一版 changed=true', v1.changed === true)
  check('第一版 version=1', v1.version === 1)
  check('第一版 reason=初始计划', v1.reason === '初始计划')
  check('planVersions 有一条', taskCore.get(t1.id).planVersions.length === 1)
  check('当前 plan 是新计划', taskCore.get(t1.id).plan.join('|') === '读配置|改代码')
  check(
    'planHash 已写',
    taskCore.get(t1.id).planHash === taskPlan.fingerprint(['读配置', '改代码']),
  )

  /* ── ② 同一份计划再来一次（模型每轮复述）─────────────── */
  group('计划版本 / 没变不记新版本')
  const updatedAtBefore = taskCore.get(t1.id).updatedAt
  await sleep(5)
  const same = taskCore.setPlan(t1.id, ['读配置', '改代码'])

  check('★ 同计划 changed=false', same.changed === false)
  check('★ 同计划不增加版本', taskCore.get(t1.id).planVersions.length === 1)
  check('同计划 version 还是 1', same.version === 1)
  check('★ 没变就不写盘（updatedAt 不动）', taskCore.get(t1.id).updatedAt === updatedAtBefore)

  /* ── ③ 改计划 → 保留历史 ──────────────────────────────── */
  group('计划版本 / 改了要留旧版')
  await sleep(5)
  const v2 = taskCore.setPlan(t1.id, ['读配置', '改代码', '跑测试'])

  check('★ 改计划 changed=true', v2.changed === true)
  check('★ 改计划 version=2', v2.version === 2)
  check('改计划 reason=重新规划', v2.reason === '重新规划')
  check(
    '★ 旧版还在（历史保留）',
    taskCore.get(t1.id).planVersions[0].plan.join('|') === '读配置|改代码',
  )
  check(
    '新版是第二条',
    taskCore.get(t1.id).planVersions[1].plan.join('|') === '读配置|改代码|跑测试',
  )
  check('当前 plan 指向新版', taskCore.get(t1.id).plan.join('|') === '读配置|改代码|跑测试')
  check(
    'planHash 跟着新版走',
    taskCore.get(t1.id).planHash === taskPlan.fingerprint(['读配置', '改代码', '跑测试']),
  )
  check('版本带时间戳', taskCore.get(t1.id).planVersions[1].at > 0)

  /* ── ④ 第三版 + 自定义原因 ────────────────────────────── */
  group('计划版本 / 自定义原因')
  const v3 = taskCore.setPlan(t1.id, ['换一条路'], { reason: '用户改了要求' })
  check('第三版 version=3', v3.version === 3)
  check('自定义 reason 生效', v3.reason === '用户改了要求')
  check('三条历史都在', taskCore.get(t1.id).planVersions.length === 3)

  /* ── ⑤ 边界：空计划、不存在的任务 ─────────────────────── */
  group('计划版本 / 边界')
  check('空数组返回 null', taskCore.setPlan(t1.id, []) === null)
  check('非数组返回 null', taskCore.setPlan(t1.id, null) === null)
  check('不存在的任务返回 null', taskCore.setPlan('task_不存在', ['a']) === null)
  check('空数组不会记版本', taskCore.get(t1.id).planVersions.length === 3)

  /* ── ⑥ 老任务迁移 ─────────────────────────────────────── */
  group('计划版本 / 老任务迁移')
  const legacy = { id: 'task_legacy', plan: ['老乙', '老丙'], updatedAt: 1700000000000 }
  const migrated = taskPlan.migrate(JSON.parse(JSON.stringify(legacy)))
  check('★ 老任务补出 planVersions', migrated.planVersions.length === 1)
  check('★ 迁移不改 plan', migrated.plan.join('|') === '老乙|老丙')
  check('迁移标为初始计划', migrated.planVersions[0].reason === '初始计划')
  check('迁移用 updatedAt 当时间', migrated.planVersions[0].at === 1700000000000)

  const noPlan = taskPlan.migrate({ id: 'task_x', plan: [] })
  check(
    '没计划的老任务给空数组',
    Array.isArray(noPlan.planVersions) && noPlan.planVersions.length === 0,
  )

  const already = {
    id: 'task_y',
    plan: ['a'],
    planVersions: [{ plan: ['a'], at: 1, reason: '初始计划' }],
  }
  check('已有版本的原样返回', taskPlan.migrate(already) === already)

  /* ── ⑦ get() 读盘也会迁移（老 JSON 文件）──────────────── */
  group('计划版本 / 读盘迁移')
  const legacyId = 'task_selftest_legacy_plan'
  const file = join(paths.DIRS.data, 'tasks', `${legacyId}.json`)
  writeFileSync(
    file,
    JSON.stringify({ id: legacyId, plan: ['盘上的老计划'], status: 'running', createdAt: 1 }),
    'utf8',
  )
  const readBack = taskCore.get(legacyId)
  check('★ 读盘的老任务也被迁移', readBack && readBack.planVersions.length === 1)
  check('读盘老任务的 plan 没丢', readBack.plan[0] === '盘上的老计划')
  /* 迁移只补内存，不动文件 —— 老数据一个字节都不该被顺手改掉 */
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  check('★ 迁移不落盘（老文件仍无 planVersions）', onDisk.planVersions === undefined)
  rmSync(file, { force: true })

  /* ── ⑧ capturePlan：变了才返回 ────────────────────────── */
  group('计划版本 / capturePlan 变了才返回')
  const t2 = newTask()
  const first = taskContext.capturePlan({ taskId: t2.id, content: '```plan\n- 一\n- 二\n```' })
  check('★ 第一次捕获返回对象', first !== null && first.version === 1)
  check('返回里带 plan', first.plan.join('|') === '一|二')

  const repeat = taskContext.capturePlan({ taskId: t2.id, content: '```plan\n- 一\n- 二\n```' })
  check('★ 同一份计划再捕获返回 null', repeat === null)

  const changed = taskContext.capturePlan({
    taskId: t2.id,
    content: '```plan\n- 一\n- 二\n- 三\n```',
  })
  check('★ 换了计划又返回对象', changed !== null && changed.version === 2)
  check(
    'capturePlan 没有 plan 时返回 null',
    taskContext.capturePlan({ taskId: t2.id, content: '没有计划块' }) === null,
  )
  check(
    'capturePlan 没有 taskId 时返回 null',
    taskContext.capturePlan({ taskId: '', content: '```plan\n- a\n```' }) === null,
  )

  /* ── ⑨ 接线守卫：loop 不许再有「只抓第一次」的布尔量 ──── */
  group('计划版本 / 接线守卫')
  const loopSrc = readFileSync(join(ROOT, 'electron/core/loop.cjs'), 'utf8')
  check('★ loop.cjs 里没有 planParsed', !loopSrc.includes('planParsed'))
  check('loop.cjs 调 capturePlan', loopSrc.includes('taskContext.capturePlan'))
  check('loop.cjs 发 plan 事件时展开结果', /emit\(\{\s*type: 'plan'/.test(loopSrc))

  const planSrc = readFileSync(join(ROOT, 'electron/core/task-plan.cjs'), 'utf8')
  check('task-plan.cjs 导出 recordVersion', planSrc.includes('recordVersion'))
  check('task-plan.cjs 导出 migrate', planSrc.includes('migrate('))

  /* ── 收尾 ─────────────────────────────────────────────── */
  for (const id of created) taskCore.remove(id)
  check(
    '测试任务已清理',
    created.every((id) => taskCore.get(id) === null),
  )
}
