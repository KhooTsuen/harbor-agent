/**
 * 自检 / 记忆：冲突判定的范围（只在同类型 + 同范围里取代）+ 过期是标记不是删除
 *
 * 这一组钉两条**真实踩过的**：
 *   · P0-1：`findConflicts` 的 `||` 优先级 bug —— containment 分支逃出了
 *     「同类型 + 同 scope + active」三个约束，于是跨类型 / 跨范围 / 已退场的旧记忆
 *     都会被静默标成 superseded（不再注入）。文件头与注释一直写的是「同类型 + 同 scope」，
 *     **写得对、代码是错的** —— 这种「只有真跑才现形」的正是本组存在的理由。
 *   · P0-3：`pruneExpired` 以前直接 filter 删掉，违反 §56 Forget ≠ Delete。
 *
 * 冲突判定本身是纯函数（`memory-similarity.cjs`），这里只喂手造对象；
 * 「真写盘」那条由存储层接口（`memory.add` / `retrieve` / `enable`）走查，写完即删，
 * 不给后续组留脏数据。
 */

import { check, group } from '../harness.mjs'
import { join, memory, require, ROOT, tools } from '../env.mjs'

const sim = require(join(ROOT, 'electron/core/memory-similarity.cjs'))

/** 造一条旧记忆（只留冲突判定用到的字段） */
function older(content, over = {}) {
  return { id: 'old', status: 'active', type: 'preference', scope: 'global', content, ...over }
}

export async function run() {
  group('记忆冲突 / 只在同类型 + 同范围里取代（P0-1 优先级 bug）')
  const short = '改完 UI 必须真跑一遍再看结论'
  const long = '改完 UI 必须真跑一遍再看结论，测试绿不算数'
  const next = { type: 'preference', scope: 'global', content: long }

  const same = sim.findConflicts([older(short)], next)
  check('同类型 + 同范围 + 高度包含 → 判为冲突', same.length === 1, JSON.stringify(same.map((i) => i.id)))

  const crossType = sim.findConflicts([older(short, { type: 'fact' })], next)
  check('★ 不同类型不算冲突（这一条正是那个 || 优先级 bug 的回归钉）', crossType.length === 0, JSON.stringify(crossType.map((i) => i.id)))

  const crossScope = sim.findConflicts([older(short, { scope: 'project' })], next)
  check('★ 不同范围不算冲突', crossScope.length === 0, JSON.stringify(crossScope.map((i) => i.id)))

  const gone = sim.findConflicts([older(short, { status: 'superseded' })], next)
  check('★ 已退场的条目不参与取代判定', gone.length === 0)

  const offList = sim.findConflicts([older(short, { type: 'temporary' })], { type: 'temporary', scope: 'global', content: long })
  check('不在冲突名单里的类型（temporary）不判冲突', offList.length === 0)
  check(
    '冲突名单可核对：含 preference、不含 fact / temporary',
    sim.CONFLICT_TYPES.includes('preference') &&
      !sim.CONFLICT_TYPES.includes('fact') &&
      !sim.CONFLICT_TYPES.includes('temporary'),
    sim.CONFLICT_TYPES.join(','),
  )

  group('记忆写入 / 类型由模型说清（P0-2）')
  const schema = tools.toApiSchema()
  const props = schema.find((t) => t.function.name === 'remember')?.function?.parameters?.properties ?? {}
  check('remember 暴露了 type 参数', Boolean(props.type), Object.keys(props).join(','))
  check(
    '★ type 的候选值就是内核那份类型表（形状对齐，不各写一套）',
    JSON.stringify(props.type?.enum) === JSON.stringify(memory.TYPES),
    JSON.stringify(props.type?.enum),
  )

  check(
    '带 type 的调用能过参数校验（schema 真的跑到校验这一步）',
    tools.validateArgs('remember', { content: 'x', type: 'constraint' }).length === 0,
  )

  const spill = []
  const typed = memory.append({ content: '自检临时：这是一条约束', type: 'constraint' })
  check('★ append 采纳了模型给的类型（以前一律写死成 fact）', typed.ok === true && typed.item?.type === 'constraint', String(typed.item?.type))
  if (typed.item?.id) spill.push(typed.item.id)

  const unknown = memory.append({ content: '自检临时：类型不认识', type: '不存在的类型' })
  check('不认识的类型退回 fact', unknown.item?.type === 'fact', String(unknown.item?.type))
  if (unknown.item?.id) spill.push(unknown.item.id)

  group('记忆过期 / 标记而不是删除（P0-3）')
  const expiring = memory.add({ content: '自检临时：马上就该过期的记忆', type: 'fact', expiresAt: Date.now() - 1000 })
  check('能加一条带过期时间的记忆', expiring.ok === true)
  const id = expiring.item?.id
  if (id) spill.push(id)

  const find = () => memory.list({ includeSuperseded: true }).find((i) => i.id === id)
  check('过期前状态是 active', find()?.status === 'active', String(find()?.status))

  /* retrieve 内部会跑 pruneExpired —— 走最真实的触发路径，不直接调私有函数 */
  memory.retrieve({ query: '自检临时' })
  check('★ 过期后条目还在（不是被物理删除）', Boolean(find()), '条目已消失，又回到了「过期即删」')
  check('★ 状态变成 expired（§56 Forget ≠ Delete）', find()?.status === 'expired', String(find()?.status))
  check('过期的不再被注入', memory.retrieve({ query: '自检临时' }).every((i) => i.id !== id))

  memory.enable(id)
  check(
    '★ 启用会清掉过期时间（否则下次检索立刻又标回 expired）',
    find()?.status === 'active' && find()?.expiresAt === 0,
    `${find()?.status} / ${find()?.expiresAt}`,
  )
  memory.retrieve({ query: '自检临时' })
  check('★ 启用之后不会被立刻标回 expired', find()?.status === 'active', String(find()?.status))

  for (const spillId of spill) memory.remove(spillId)
}
