/**
 * 自检 / ②-3 同一件事跑两遍的一致性检查
 *
 * 清单里这一条原本是：
 *   ❌「同一任务多次执行的一致性检查 —— 没做」
 *
 * 三条要守住的：
 *   ① 只跟**比它早**的任务比（拿后来的当参照没有意义）
 *   ② 找不出可比对象就**一个字都不写** —— 硬凑一句「两次一致」是编
 *   ③ 措辞是「对不上」，**不是**「有问题」：差异大不等于做错了
 */

import { check, group } from '../harness.mjs'
import { disposeTasks, join, require, ROOT, taskCore } from '../env.mjs'

export async function run() {
  const consistency = require(join(ROOT, 'electron/core/task-consistency.cjs'))
  const diagnoseCore = require(join(ROOT, 'electron/core/task-diagnose.cjs'))

  const t = (patch) => ({
    id: patch.id ?? 'x',
    goal: patch.goal ?? '',
    status: patch.status ?? 'completed',
    createdAt: patch.createdAt ?? 1000,
    changedFiles: patch.changedFiles ?? [],
    plan: patch.plan ?? [],
    commands: patch.commands ?? [],
    sessionId: 'selftest-02-3',
    ...patch,
  })

  group('②-3 / 找的是哪一条')
  const mine = t({ id: 'now', goal: '帮我修一下登录页的样式', createdAt: 5000 })
  const older = t({ id: 'old', goal: '帮我修一下登录页的样式吧', createdAt: 1000, status: 'failed' })
  const later = t({ id: 'later', goal: '帮我修一下登录页的样式', createdAt: 9000 })
  const other = t({ id: 'other', goal: '把 README 里的错别字改了', createdAt: 800 })

  const found = consistency.findPrior([older, later, other, mine], mine)
  check('★ 找得到那一趟', found?.task?.id === 'old', JSON.stringify(found?.task?.id))
  check('★ 不拿自己跟自己比', consistency.findPrior([mine], mine) === null)
  check(
    '★ 不拿**后来的**当参照',
    consistency.findPrior([later], mine) === null,
    'later 比 mine 晚，不该被选中',
  )
  check('不像的目标不硬凑', consistency.findPrior([other], mine) === null)
  check('目标是空的就不比', consistency.findPrior([older], t({ goal: '   ' })) === null)
  check(
    '最像的那条胜出（多条候选时）',
    consistency.findPrior(
      [older, t({ id: 'near', goal: '帮我修一下登录页的样式', createdAt: 2000 })],
      mine,
    )?.task?.id === 'near',
  )

  group('②-3 / 差在哪')
  const a = t({
    id: 'A',
    createdAt: 1000,
    status: 'completed',
    changedFiles: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
    plan: ['[x] 一', '[x] 二'],
  })
  const b = t({
    id: 'B',
    createdAt: 2000,
    status: 'failed',
    changedFiles: [{ path: 'src/c.ts' }],
    plan: ['[x] 一'],
  })
  const cmp = consistency.compare(a, b, 0.8)
  check('★ 认得出两次对不上', cmp.divergent === true, JSON.stringify(cmp.notes))
  check('说得出结论不一样', cmp.notes.some((n) => n.includes('结论不一样')), cmp.notes.join(' | '))
  check(
    '说得出改动范围不一样',
    cmp.notes.some((n) => n.includes('改动范围不一样')),
    cmp.notes.join(' | '),
  )
  check('带上了相似度', cmp.score === 0.8)

  const same = consistency.compare(a, t({ ...a, id: 'A2' }), 0.9)
  check('★ 真一致时不硬说差异', same.divergent === false && same.notes.length === 0, JSON.stringify(same.notes))

  /* 数量一样但动的不是同一批 —— 那才是「做的事不一样」 */
  const c = t({ id: 'C', createdAt: 3000, changedFiles: [{ path: 'src/z.ts' }, { path: 'src/y.ts' }] })
  check(
    '★ 数量一样但文件不同 → 也要说',
    consistency.compare(a, c).notes.some((n) => n.includes('不是同一批文件')),
    JSON.stringify(consistency.compare(a, c).notes),
  )

  /* 两边都没跑测试不是差异 */
  check(
    '★ 都没跑测试不算差异（别拿「没做」当成不一致）',
    consistency
      .compare(a, t({ ...a, id: 'A3', changedFiles: a.changedFiles }), 0)
      .notes.every((n) => !n.includes('测试')),
    JSON.stringify(consistency.compare(a, t({ ...a, id: 'A3' }), 0).notes),
  )

  group('②-3 / 时间说法')
  check('刚跑完说「刚刚」', consistency.whenAgo(Date.now() - 10 * 1000) === '刚刚')
  check('半小时前', consistency.whenAgo(Date.now() - 30 * 60 * 1000) === '30 分钟前')
  check('三小时前', consistency.whenAgo(Date.now() - 3 * 3600 * 1000) === '3 小时前')
  check('时间读不出来就不说', consistency.whenAgo(0) === '' && consistency.whenAgo(undefined) === '')

  group('②-3 / 诊断报告里真的出现')
  const made = []
  try {
    const first = taskCore.create({ goal: '把设置页里的按钮对齐修一下', sessionId: 'selftest-02-3' })
    made.push(first.id)
    taskCore.update(first.id, {
      status: 'completed',
      changedFiles: [{ path: 'src/one.ts' }],
    })
    const second = taskCore.create({ goal: '把设置页里的按钮对齐修一下', sessionId: 'selftest-02-3' })
    made.push(second.id)
    taskCore.update(second.id, {
      status: 'failed',
      changedFiles: [{ path: 'src/two.ts' }, { path: 'src/three.ts' }],
    })

    const text = String(diagnoseCore.diagnose(taskCore.get(second.id)).text)
    check('★ 报告里指出「之前跑过一次」', text.includes('这件事之前跑过一次'), text.slice(-160))
    check('★ 报告里列出对不上的地方', text.includes('结论不一样') || text.includes('改动范围不一样'), text.slice(-160))

    /* 反过来：没有可比对象时**一个字都不写** */
    const lonely = taskCore.create({ goal: '一件完全不同的事情', sessionId: 'selftest-02-3' })
    made.push(lonely.id)
    const lonelyText = String(diagnoseCore.diagnose(taskCore.get(lonely.id)).text)
    check(
      '★ 没有可比对象就不提这一茬（硬凑一句「两次一致」是编）',
      !lonelyText.includes('之前跑过一次'),
      lonelyText.split('\n').filter((line) => line.includes('跑过一次')).join(' / '),
    )
  } finally {
    /*
     * ★ 必须用 disposeTasks，不能直接 removeSafe：
     *   `lonely` 建完就没改过状态，一直是 running，而内核**拒绝删在跑的任务** ——
     *   上一版就是这么把测试任务堆在 `data/tasks/` 里的（查出来时已经 647 个）。
     */
    const left = disposeTasks(made)
    check('★ 测试建的任务都删干净了（不许堆在数据目录里）', left.length === 0, left.join(','))
    check(
      '★ 删完真的不在了',
      made.every((id) => taskCore.get(id) === null),
      made.map((id) => `${id}:${taskCore.get(id) ? '还在' : '没了'}`).join(' '),
    )
  }
}
