/**
 * 自检 / 定时任务：时间计算与台账（72-schedule 的零件）
 *
 * 为什么拆出来：定时任务这一组十段、62 条断言，全塞进组文件里是 409 行 ——
 * 顶破 `AGENT.md` 硬约束 #2（单文件 ≤ 300 行）。切的口子按**职责**来：
 *   · 这里 = 纯函数（什么时候该跑）+ 落盘（台账读写与校验）
 *   · `72-schedule-run-parts.mjs` = 授权上限 + 执行器（真正要反复审的那两块）
 * 拆开之后失败也更好读：这里红了 = 时间算错 / 台账写坏；那边红了 = 授权放宽了。
 *
 * 断言文案与组标题原样保留（免得既有的失败清单对不上号）。
 */

import { check, group } from '../harness.mjs'

/** 1~3 段：validateWhen / nextRunAt / isDue */
export function runTimeChecks({ next }) {
  group('定时任务 / 时间校验')
  check('间隔 4 分钟被拒，理由是人话', (() => {
    const result = next.validateWhen({ type: 'interval', minutes: 4 })
    return result.ok === false && /不能小于 5 分钟/.test(result.error)
  })())
  check('间隔正好 5 分钟可以', next.validateWhen({ type: 'interval', minutes: 5 }).ok === true)
  check('间隔不是数字被拒', next.validateWhen({ type: 'interval', minutes: '一会儿' }).ok === false)
  check('at 写成 25:99 被拒，理由是人话', (() => {
    const result = next.validateWhen({ type: 'daily', at: '25:99' })
    return result.ok === false && /HH:MM/.test(result.error)
  })())
  check('daily 缺 at 被拒', next.validateWhen({ type: 'daily' }).ok === false)
  check('daily 09:30 可以', next.validateWhen({ type: 'daily', at: '09:30' }).ok === true)
  check('不是对象 / 不认识的类型都被拒', (() => {
    return (
      next.validateWhen(null).ok === false &&
      next.validateWhen({}).ok === false &&
      next.validateWhen({ type: 'cron', expr: '* * * * *' }).ok === false
    )
  })())

  group('定时任务 / 下一次该跑的时刻')
  const anchor = new Date(2026, 0, 5, 12, 0, 0).getTime()
  check(
    '★ interval 30 分钟 = 基准 + 30 分钟',
    next.nextRunAt({ type: 'interval', minutes: 30 }, anchor) === anchor + 30 * 60_000,
  )
  check('★ daily 算出来的**本地**时分确实是 09:30（不是 UTC）', (() => {
    const at = next.nextRunAt({ type: 'daily', at: '09:30' }, anchor)
    const date = new Date(at)
    return date.getHours() === 9 && date.getMinutes() === 30 && at > anchor
  })())
  check('daily：今天还没到点 → 就是今天', (() => {
    const morning = new Date(2026, 0, 5, 8, 0, 0).getTime()
    return new Date(next.nextRunAt({ type: 'daily', at: '09:30' }, morning)).getDate() === 5
  })())
  check('非法输入一律返回 0', (() => {
    return (
      next.nextRunAt({ type: 'daily', at: '99:99' }, anchor) === 0 &&
      next.nextRunAt({ type: 'interval', minutes: 0 }, anchor) === 0 &&
      next.nextRunAt(null, anchor) === 0 &&
      next.nextRunAt({ type: 'interval', minutes: 30 }, NaN) === 0
    )
  })())
  check('中文短句', (() => {
    return (
      next.describeWhen({ type: 'interval', minutes: 30 }) === '每 30 分钟' &&
      next.describeWhen({ type: 'daily', at: '09:30' }) === '每天 09:30' &&
      next.describeWhen({ type: 'daily', at: '9:3' }) === '时间设置无效'
    )
  })())

  group('定时任务 / 该不该跑（含防抖）')
  const now = Date.now()
  check('enabled:false → 不跑', next.isDue({ enabled: false, when: { type: 'interval', minutes: 30 } }, now) === false)
  check(
    '★ 刚跑过就不算到期（lastRunAt = now-10s）',
    next.isDue({ enabled: true, when: { type: 'interval', minutes: 30 }, lastRunAt: now - 10_000 }, now) === false,
  )
  check(
    '★ 2 分钟前跑的、间隔 1 分钟 → 到期',
    next.isDue({ enabled: true, when: { type: 'interval', minutes: 1 }, lastRunAt: now - 120_000 }, now) === true,
  )
  check(
    '没跑过：从创建时刻推（1 小时前建的、间隔 30 分钟 → 到期）',
    next.isDue(
      { enabled: true, when: { type: 'interval', minutes: 30 }, createdAt: now - 3_600_000 },
      now,
    ) === true,
  )
  check(
    '刚建出来、还没到点 → 不跑；时间配置不合法 → 不跑（fail-closed）',
    next.isDue({ enabled: true, when: { type: 'interval', minutes: 30 }, createdAt: now }, now) === false &&
      next.isDue({ enabled: true, when: { type: 'daily', at: '99:99' }, createdAt: 0 }, now) === false,
  )
}

/**
 * 第 6 段：台账落盘与校验。
 *
 * `store` 已经被组入口用 `setFilePathForTest` 指到沙箱了 —— 这里**不许**
 * 自己再指一遍（两处各指一次，早晚有一处会忘）。
 */
export function runLedgerChecks({ store, join, readFileSync, SANDBOX }) {
  group('定时任务 / 台账落盘与校验')
  const created = store.save({
    name: '每天早上看看项目',
    when: { type: 'daily', at: '09:30' },
    prompt: '看一下 git status，把改动总结成三行',
    workdir: SANDBOX,
    grant: 'readonly',
  })
  check('保存成功并给了 id', created.ok === true && /^sch_/.test(created.item?.id ?? ''), created.error)
  check('落盘形状是 {version:1, items:[…]}', (() => {
    const onDisk = JSON.parse(readFileSync(store.filePath(), 'utf8'))
    return onDisk.version === 1 && Array.isArray(onDisk.items) && onDisk.items.length === 1
  })())
  check('list() 从磁盘读得回', store.list().length === 1 && store.get(created.item.id)?.name === '每天早上看看项目')
  check('空名字被拒', store.save({ name: '  ', when: { type: 'interval', minutes: 30 }, prompt: 'p', workdir: SANDBOX, grant: 'readonly' }).ok === false)
  check('名字超过 60 字被拒', store.save({ name: '长'.repeat(61), when: { type: 'interval', minutes: 30 }, prompt: 'p', workdir: SANDBOX, grant: 'readonly' }).ok === false)
  check('提示词超过 2000 字被拒', store.save({ name: 'x', when: { type: 'interval', minutes: 30 }, prompt: 'y'.repeat(2001), workdir: SANDBOX, grant: 'readonly' }).ok === false)
  check('★ 提示词里含 sk- 一律拒绝保存（每轮都进上下文的东西不许混密钥）', (() => {
    const result = store.save({
      name: 'x',
      when: { type: 'interval', minutes: 30 },
      prompt: '把 key sk-abcdefghijklmnopqrstuvwxyz 记下来',
      workdir: SANDBOX,
      grant: 'readonly',
    })
    return result.ok === false && /密钥|令牌/.test(result.error)
  })())
  check('权限档不在名单里被拒', store.save({ name: 'x', when: { type: 'interval', minutes: 30 }, prompt: 'p', workdir: SANDBOX, grant: '随便写' }).ok === false)
  check('时间不合法被拒', store.save({ name: 'x', when: { type: 'interval', minutes: 1 }, prompt: 'p', workdir: SANDBOX, grant: 'readonly' }).ok === false)
  check('★ 工作目录不存在 → 回落空串（不是报错，不然换台机器任务就没了）', (() => {
    const before = store.list().length
    const result = store.save({
      name: '回落',
      when: { type: 'interval', minutes: 30 },
      prompt: 'p',
      workdir: join(SANDBOX, '这个目录不存在'),
      grant: 'workspace',
    })
    const ok = result.ok === true && result.item.workdir === ''
    /* 这一条是**自己新建**的（没有 id 就是新建）：用完立刻删掉。
       不删的话，后面「改一条之后只应该有 1 条」「删掉之后 0 条」会假红 ——
       那不是台账错了，是测试自己留了一条。 */
    if (result.ok) store.remove(result.item.id)
    return ok && store.list().length === before
  })())
  check('改一条：id 不变、不新增', (() => {
    const result = store.save({ id: created.item.id, name: '改过的名字' })
    return result.ok === true && result.item.id === created.item.id && store.list().length === 1 && store.get(created.item.id).name === '改过的名字'
  })())
  check('带了不存在的 id → 报错，不许当新建', store.save({ id: 'sch_不存在', name: 'x' }).ok === false)
  check('开关', store.setEnabled(created.item.id, false).ok === true && store.get(created.item.id).enabled === false)
  check('写回运行结果：只认该认的字段', (() => {
    const result = store.recordRun(created.item.id, {
      lastRunAt: 123,
      lastTaskId: 'task_x',
      lastResult: '跑完了',
      runCount: 2,
      blockedCount: 1,
      name: '想偷改名字',
    })
    const item = store.get(created.item.id)
    return (
      result.ok === true &&
      item.lastTaskId === 'task_x' &&
      item.runCount === 2 &&
      item.blockedCount === 1 &&
      item.name === '改过的名字'
    )
  })())
  check('删掉之后读不到', (() => {
    const removed = store.remove(created.item.id)
    return removed.ok === true && store.get(created.item.id) === null && store.list().length === 0 && store.remove(created.item.id).ok === false
  })())
}
