/**
 * 自检 / CE-007 脑暴对齐与北极星锚定（Phase 6 批次 2）
 *
 * 参考 dsh-routing-suite 的「北极星」：复杂任务先与用户对齐，再定稿一句
 * 「做成什么样算完成」的目的宣言，之后每轮回显，防长任务跑偏。
 *
 * Harbor 的落地（见 docs/research/phase6-governance-routing-design.md）：
 *   · **不新增任何工具** —— 对齐复用已有的 `ask_user`（≤3 题 / 2-4 选项 / 必带默认值）；
 *   · **北极星存 `task.star`**（与 goal 分开，保护用户原话的纯净语义）；
 *   · 由计划块里**显式写的一行** `北极星：…` 捕获（不解析自然语言猜测）；
 *   · **首次定格**（模型每轮重发计划块、措辞会飘，漂了就失去锚点意义）；
 *   · 每轮注入 **taskState（易变区）**，绝不进稳定区（否则破坏前缀缓存）。
 *
 * 这一组盯五件事：解析对不对、落盘与定格、**老数据可读**（本批次重中之重）、
 * 回显进了 taskState、以及「不新增工具 / 走原子写」这两条边界的接线守卫。
 */

import { check, group } from '../harness.mjs'
import { ROOT, contextDiagCore, fsCore, join, promptStackCore, readFileSync, require } from '../env.mjs'

const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const taskPlan = require(join(ROOT, 'electron/core/task-plan.cjs'))
const taskContext = require(join(ROOT, 'electron/core/task-context.cjs'))
const taskHint = require(join(ROOT, 'electron/core/task-hint.cjs'))
const taskIo = require(join(ROOT, 'electron/core/task-io.cjs'))
const promptRules = require(join(ROOT, 'electron/core/prompt-rules.cjs'))

export async function run() {
  const created = []

  /* ── ① 计划块里解析出北极星 ───────────────────────────── */
  group('北极星 / 从计划块里解析')
  const b1 = taskPlan.parsePlanBlock(
    '```plan\n# 重构鉴权\n北极星：登录失败率降到 0，且不破坏既有测试\n- [ ] 读现状\n- [ ] 改\n```',
  )
  check('★ 抠出北极星那一行', b1.star === '登录失败率降到 0，且不破坏既有测试')
  check('★ 北极星不算一步', b1.steps.join('|') === '[ ] 读现状|[ ] 改')
  check('任务名不受影响', b1.title === '重构鉴权')

  const bBefore = taskPlan.parsePlanBlock('```plan\n北极星：先把 baseline 建起来\n# 名字\n- a\n```')
  check('北极星写在任务名上面也认', bBefore.star === '先把 baseline 建起来' && bBefore.title === '名字')
  const bEn = taskPlan.parsePlanBlock('```plan\nstar: keep it simple\n- a\n```')
  check('英文 `star:` 写法也认', bEn.star === 'keep it simple')

  const bNone = taskPlan.parsePlanBlock('```plan\n- [ ] 读\n- [ ] 改\n```')
  check('没有北极星 → 空串（不硬编）', bNone.star === '' && !('北极星' in bNone))
  check('老接口 parsePlan 行为不变（只给步骤）', taskCore.parsePlan('```plan\n北极星：X\n- 一\n```').join('|') === '一')

  check('归一化：压掉多余空白', taskPlan.normalizeStar('  多余   空白  ') === '多余 空白')
  check('归一化：超 200 字截断', taskPlan.normalizeStar('x'.repeat(300)).length === 200)

  /* ── ② 建任务时的初值 + 落盘 + 首次定格 ───────────────── */
  group('北极星 / 建任务 + 落盘 + 定格')
  const sid = 'selftest-north-star'
  const t = taskCore.create({ goal: '把鉴权模块重构一遍', sessionId: sid })
  created.push(t.id)
  check('★ 新任务的 star 初值是空串', t.star === '')

  const cap = taskContext.capturePlan({
    taskId: t.id,
    content: '```plan\n# 重构鉴权\n北极星：登录失败率降到 0\n- [ ] 读现状\n- [ ] 改\n```',
  })
  check('★ capturePlan 把北极星交出来', cap && cap.star === '登录失败率降到 0')
  check('★ 北极星真的落到了盘上（读回来还在）', taskCore.get(t.id).star === '登录失败率降到 0')

  /* 第二版计划带了**不同**的北极星 —— 定稿的那句不该被覆盖 */
  taskContext.capturePlan({
    taskId: t.id,
    content: '```plan\n# 重构鉴权\n北极星：换一句完全不同的话\n- [x] 读现状\n- [ ] 改\n```',
  })
  check('★ 北极星首次定格（后续不同措辞不覆盖）', taskCore.get(t.id).star === '登录失败率降到 0')

  /* 没带北极星的计划块，不该把已有的弄丢，也不该凭空造一个 */
  taskCore.setPlan(t.id, ['[x] 读现状', '[x] 改', '[ ] 测'])
  check('不带北极星的计划 → 保持原样', taskCore.get(t.id).star === '登录失败率降到 0')

  /* update 白名单里必须有 star（否则静默丢掉） */
  taskCore.update(t.id, { star: '手动改写的一句' })
  check('★ update 白名单放行 star（不是静默丢掉）', taskCore.get(t.id).star === '手动改写的一句')
  taskCore.update(t.id, { star: '登录失败率降到 0' })

  /* ── ③ ★ 老数据可读（本批次重中之重）───────────────────── */
  group('北极星 / 老数据迁移（缺字段不能报错）')
  const legacyId = 'task_legacy_nostar'
  const legacyRaw = {
    id: legacyId,
    title: '老任务',
    goal: '老目标（升级前建的）',
    status: 'paused',
    plan: ['[ ] a', '[ ] b'],
    updatedAt: Date.now(),
    createdAt: Date.now(),
    /* 故意**没有** star、也没有 planVersions —— 模拟升级前的老台账 */
  }
  fsCore.mkdirSync(taskIo.root(), { recursive: true })
  fsCore.writeFileSync(taskIo.fileFor(legacyId), JSON.stringify(legacyRaw), 'utf8')
  const legacy = taskCore.get(legacyId)
  check('★ 老任务（没有 star 字段）读得出来、不报错', Boolean(legacy))
  check('★ 老任务读出 star = 空串（不是 undefined）', legacy && legacy.star === '')
  check('老任务的 goal 原样保留（没被拿去当 star）', legacy && legacy.goal === '老目标（升级前建的）')
  check('迁移只在内存补：planVersions 也补出来了', legacy && Array.isArray(legacy.planVersions) && legacy.planVersions.length === 1)
  check('迁移不落盘（磁盘文件仍是老样子）', !fsCore.readFileSync(taskIo.fileFor(legacyId), 'utf8').includes('"star"'))
  taskIo.remove(legacyId)

  const migrated = taskPlan.migrate({ id: 'x', title: '老', plan: ['a'], goal: '老' })
  check('migrate 直接补空（纯函数）', migrated.star === '')

  /* ── ④ 回显进 taskState（易变区，不碰稳定区）───────────── */
  group('北极星 / 回显（易变区）')
  const ts = taskContext.buildTaskState({ sessionId: sid })
  check('★ taskState 里出现「北极星：…」', ts.includes('北极星：登录失败率降到 0'))
  const tsOther = taskContext.buildTaskState({ sessionId: 'no-such-session-xyz' })
  check('别的会话 / 老任务不注入北极星（没有就不出现）', !tsOther.includes('北极星'))

  const taskStateLayer = contextDiagCore.tierOf('taskState')
  check('★ 北极星的家（taskState）在易变区，不是稳定区', taskStateLayer !== 'stable')
  check('★ 稳定区里没有 star 层（绝不能进稳定区）', !promptStackCore.ORDER.includes('star') && !promptStackCore.ORDER.includes('northStar'))

  /* ── ⑤ 接线守卫（不新增工具 / 走原子写 / 提示词）───────── */
  group('北极星 / 接线与边界守卫')
  const ioSrc = readFileSync(join(ROOT, 'electron/core/task-io.cjs'), 'utf8')
  check('★ 落盘走 safe-write.writeAtomic（E2 原子写底座）', /writeAtomic\(/.test(ioSrc) && /safe-write\.cjs/.test(ioSrc))
  check('★ 台账写盘只有 io.write 一处（star 走的就是它）', /function write\(task\)/.test(ioSrc))

  const createSrc = readFileSync(join(ROOT, 'electron/core/task-create.cjs'), 'utf8')
  check('★ 初始对象里有 star 字段', /^\s*star:\s*''/m.test(createSrc))
  const coreSrc = readFileSync(join(ROOT, 'electron/core/task.cjs'), 'utf8')
  check('★ update 白名单里有 star', /'star',/.test(coreSrc))
  const ctxSrc = readFileSync(join(ROOT, 'electron/core/task-context.cjs'), 'utf8')
  check('★ capturePlan 把 star 交给 setPlan', /star:\s*block\.star/.test(ctxSrc))
  check('★ buildTaskState 注入「北极星：」', /北极星：\$\{/.test(ctxSrc))
  const planSrc = readFileSync(join(ROOT, 'electron/core/task-plan.cjs'), 'utf8')
  check('★ 只认显式「北极星：」前缀（不猜自然语言）', /北极星/.test(planSrc) && /const STAR_LINE/.test(planSrc))

  /* 对齐复用 ask_user 的既定约束：≤3 题 / 必带默认值 —— 规则文案里写死 */
  check('★ 对齐复用 ask_user（不新增工具）：规则里是 ask_user', promptStackCore.WORK_RULES.includes('`ask_user`'))
  check('★ 仍写明「一次最多 3 个问题」', promptStackCore.WORK_RULES.includes('一次最多 3 个问题'))
  check('★ 计划块格式说明里带了北极星那一行', taskHint.PLAN_FORMAT.includes('北极星'))
  check('★ 规则里也带了北极星那一行', promptRules.PLAN_RULE.includes('北极星'))
  check('★ 多步的大活 → 先对齐（CLARIFY_RULE 补了这条）', /多步的大活/.test(promptRules.CLARIFY_RULE))

  /* ── 收尾 ─────────────────────────────────────────────── */
  for (const id of created) taskCore.remove(id)
  check('测试任务已清理', created.every((id) => taskCore.get(id) === null))
}
