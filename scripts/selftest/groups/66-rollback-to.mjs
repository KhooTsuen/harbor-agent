import {
  existsSync,
  join,
  mkdirSync,
  readFileSync,
  require,
  rmSync,
  ROOT,
  SANDBOX,
  writeFileSync,
} from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-045：「回退到指定检查点」—— 撤到某一刻为止

   以前只有**整批撤**（`changeset.rollback(id)`）：一个事务改的十个文件，
   要么全撤，要么一个都不撤。可用户想说的话往往是「**刚才那几步白改了**，
   退回到第三个检查点」—— 这时整批撤会把他满意的改动也一起撤掉。

   这一组钉的就是那条时间线（先读 `core/changeset-rollback.cjs` 的头注释）：

     事务①（检查点之前）── 检查点 ── 事务②（检查点之后）
          ↑ 必须留着                    ↑ 必须撤掉

   四条「不许含糊」的边界：
     ① 检查点**之前**的改动一定不动（含「同一事务里跨检查点」的写法）；
     ② 检查点之后**新建**的文件回退 = 删掉它；
     ③ 快照丢了 / 太大没快照 → 进 `failed` 并说原因，**不许悄悄少文件**；
     ④ 老接口 `rollback(id)` 的行为一个字节都不许变。

   ⚠️ 本组**没有**登记进 `scripts/selftest.mjs`（按本轮任务要求）——
      现在只有手动跑才生效。要进验证链，得在 GROUPS 里加一行。

   ⚠️ 判据是**毫秒时间戳**（检查点的 `at` vs 文件快照的 `files[].at`），
      所以组里造数据时用一个真实的 `tick()` 把「检查点」与「之后的改动」隔开
      —— 同一毫秒内这两件事谁先谁后是说不清的。
   ══════════════════════════════════════════════════════════════ */

const SESSION = 'selftest-rollback-to'

/** 检查点与改动之间隔一次真实的时钟跳动（见上面那条 ⚠️） */
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

export async function run() {
  const changeset = require(join(ROOT, 'electron/core/changeset.cjs'))
  const taskCore = require(join(ROOT, 'electron/core/task.cjs'))

  const dir = join(SANDBOX, 'rollback-to')
  mkdirSync(dir, { recursive: true })
  const tasks = []
  const sets = []

  const newTask = (goal) => {
    const task = taskCore.create({ goal, sessionId: SESSION })
    tasks.push(task.id)
    return task
  }
  const begin = (taskId) => {
    const started = changeset.begin({ taskId, sessionId: SESSION, title: '改动' })
    if (started.ok) sets.push(started.id)
    return started.id
  }
  const lastCp = (taskId) => taskCore.get(taskId).checkpoints.at(-1)

  try {
    const task = newTask('回退到指定检查点')

    /* ── ① 检查点之前的改动：原样留着 ───────────────────── */
    group('AG-045 / 检查点之前的改动不动')
    const keep = join(dir, 'keep.txt')
    writeFileSync(keep, '第一版\n', 'utf8')
    const cs1 = begin(task.id)
    changeset.record(cs1, keep)
    writeFileSync(keep, '第二轮改过的\n', 'utf8')
    changeset.commit(cs1)
    taskCore.checkpoint(task.id, { label: '第一轮改动完成' })
    const cp1 = lastCp(task.id)
    check(
      '检查点带毫秒时间戳（它就是「检查点 id」）',
      Number.isFinite(cp1?.at) && cp1.at > 0,
      String(cp1?.at),
    )
    check('检查点里**没有** id 字段（台账本来就没这个字段）', !('id' in cp1))
    check(
      '文件快照记了「记录时刻」（判据靠它，见 core/changeset-rollback.cjs）',
      Number.isFinite(changeset.readMeta(cs1).files[0].at),
    )

    await tick()

    /* ── ② 检查点之后的改动：撤掉 ───────────────────────── */
    group('AG-045 / 检查点之后的改动被撤销')
    const undo = join(dir, 'undo.txt')
    const fresh = join(dir, 'fresh.txt')
    writeFileSync(undo, '原始\n', 'utf8')
    const cs2 = begin(task.id)
    changeset.record(cs2, undo)
    writeFileSync(undo, '改坏了\n', 'utf8')
    changeset.record(cs2, fresh) /* 本来不存在 → 回退时要删掉它 */
    writeFileSync(fresh, '新文件\n', 'utf8')
    changeset.commit(cs2)
    taskCore.checkpoint(task.id, { label: '第二轮改动完成' })

    const result = changeset.rollbackTo(task.id, cp1.at)
    check('回退报告成功', result.ok === true, JSON.stringify(result.error ?? ''))
    check(
      '★ 检查点之前的改动还在',
      readFileSync(keep, 'utf8') === '第二轮改过的\n',
      readFileSync(keep, 'utf8'),
    )
    check(
      '★ 检查点之后的改动被撤销',
      readFileSync(undo, 'utf8') === '原始\n',
      readFileSync(undo, 'utf8'),
    )
    check('检查点之后新建的文件被删掉', !existsSync(fresh))
    check(
      '恢复清单只有撤销的那一个',
      result.restored.length === 1 && result.restored[0] === undo,
      JSON.stringify(result.restored),
    )
    check(
      '删除清单是新建的那个',
      result.removed.length === 1 && result.removed[0] === fresh,
      JSON.stringify(result.removed),
    )
    check('没有失败项', result.failed.length === 0, JSON.stringify(result.failed))
    check('只撤掉第二个事务', result.changesets.join() === cs2, JSON.stringify(result.changesets))
    check(
      '回带检查点信息（at / label / 下标）',
      result.checkpoint.at === cp1.at &&
        result.checkpoint.label === '第一轮改动完成' &&
        result.checkpoint.index === 0,
      JSON.stringify(result.checkpoint),
    )
    check('检查点之前那个事务状态没被改（还是 committed）', changeset.readMeta(cs1).status === 'committed')
    check('整批撤掉的事务被标成「已回滚」', changeset.readMeta(cs2).status === 'rolled-back')

    /* ── ③ 跨检查点的事务 ──────────────────────────────── */
    group('AG-045 / 跨检查点的事务：只撤检查点之后的那几个文件')
    const mid = join(dir, 'mid.txt')
    const late = join(dir, 'late.txt')
    writeFileSync(mid, '原始 mid\n', 'utf8')
    writeFileSync(late, '原始 late\n', 'utf8')
    const cs3 = begin(task.id)
    changeset.record(cs3, mid) /* 快照在检查点之前 */
    writeFileSync(mid, '第二轮 mid\n', 'utf8')
    await tick()
    taskCore.checkpoint(task.id, { label: '中途检查点' })
    const cpMid = lastCp(task.id)
    await tick()
    changeset.record(cs3, late) /* 快照在检查点之后 */
    writeFileSync(late, '改坏的 late\n', 'utf8')
    /* 检查点之后又改了一次 mid：record 去重不再存快照（真流程就是这样） */
    changeset.record(cs3, mid)
    writeFileSync(mid, '第三轮 mid\n', 'utf8')
    changeset.commit(cs3)

    const cross = changeset.rollbackTo(task.id, cpMid.at)
    check('回退报告成功', cross.ok === true)
    check(
      '★ 检查点之后的文件被撤销',
      readFileSync(late, 'utf8') === '原始 late\n',
      readFileSync(late, 'utf8'),
    )
    check(
      '★ 检查点之前就改过的文件**不动**（拿旧快照撤它会把更早的改动也毁掉）',
      readFileSync(mid, 'utf8') === '第三轮 mid\n',
      readFileSync(mid, 'utf8'),
    )
    check(
      '没动的那个文件被点名写进 skipped（不许悄悄少文件）',
      cross.skipped.some((item) => item.path === mid && String(item.reason ?? '').length > 0),
      JSON.stringify(cross.skipped),
    )
    check(
      '跨检查点的事务不标「已回滚」（否则剩下那个就撤不动了）',
      changeset.readMeta(cs3).status === 'committed',
    )
    check('该事务仍被列出来（用户要知道动过它）', cross.changesets.includes(cs3))
    check('按数组下标也能认检查点（界面遍历数组时的写法）', changeset.rollbackTo(task.id, 2).checkpoint.at === cpMid.at)

    /* ── ④ 部分失败：说清楚，不假装成功 ────────────────── */
    group('AG-045 / 快照丢了：报出来')
    await tick()
    taskCore.checkpoint(task.id, { label: '准备一个坏掉的事务' })
    const cpLast = lastCp(task.id)
    await tick()
    const broken = join(dir, 'broken.txt')
    writeFileSync(broken, '原始 broken\n', 'utf8')
    const cs4 = begin(task.id)
    changeset.record(cs4, broken)
    writeFileSync(broken, '改坏的 broken\n', 'utf8')
    changeset.commit(cs4)
    const meta4 = changeset.readMeta(cs4)
    rmSync(join(changeset.root(), cs4, 'files', meta4.files[0].snap), { force: true })

    const failedRun = changeset.rollbackTo(task.id, cpLast.at)
    check('回退整体仍然 ok（一个文件坏掉不该让整条报废）', failedRun.ok === true)
    check(
      '★ 没恢复成功的文件进了 failed',
      failedRun.failed.length === 1 && failedRun.failed[0].path === broken,
      JSON.stringify(failedRun.failed),
    )
    check('失败项带原因（不是空串）', String(failedRun.failed[0]?.reason ?? '').length > 0)
    check(
      '文件保持原样（没被清空 / 写坏）',
      readFileSync(broken, 'utf8') === '改坏的 broken\n',
      readFileSync(broken, 'utf8'),
    )
    check(
      '有文件没恢复成功 → 事务不标「已回滚」（留着还能再试）',
      changeset.readMeta(cs4).status === 'committed',
    )

    /* 空范围：之后没有改动 → 空报告，而不是报错 */
    taskCore.checkpoint(task.id, { label: '最后一个检查点' })
    const nothing = changeset.rollbackTo(task.id, lastCp(task.id).at)
    check(
      '没有可撤的改动 → ok 但四个清单都是空的',
      nothing.ok === true &&
        nothing.restored.length === 0 &&
        nothing.removed.length === 0 &&
        nothing.failed.length === 0 &&
        nothing.changesets.length === 0,
      JSON.stringify(nothing.changesets),
    )

    /* ── ⑤ 老接口不变 ──────────────────────────────────── */
    group('AG-045 / 老行为不变：rollback(id) 仍然整批撤')
    const whole = join(dir, 'whole.txt')
    writeFileSync(whole, '原始 whole\n', 'utf8')
    const cs5 = begin(task.id)
    changeset.record(cs5, whole)
    writeFileSync(whole, '改坏的 whole\n', 'utf8')
    changeset.commit(cs5)
    const rolled = changeset.rollback(cs5)
    check('整批撤照旧成功', rolled.ok === true && rolled.restored.length === 1, JSON.stringify(rolled))
    check('整批撤把文件恢复了', readFileSync(whole, 'utf8') === '原始 whole\n')

    /* ── ⑥ 参数与边界 ──────────────────────────────────── */
    group('AG-045 / 参数与边界')
    const bare = newTask('没有检查点的任务')
    const noCp = changeset.rollbackTo(bare.id, 0)
    check('没有检查点 → 说清楚，而不是当「没有可撤的」', noCp.ok === false, JSON.stringify(noCp))
    check('失败文案点明原因', noCp.error === '这条任务还没有检查点', String(noCp.error))
    check(
      '失败也保持返回形状（界面照它渲染，不必判空）',
      Array.isArray(noCp.restored) && Array.isArray(noCp.removed) && Array.isArray(noCp.failed),
    )
    check('没给任务 id → 报错', changeset.rollbackTo('', 1).error === '没有给任务 id')
    check('任务不存在 → 报错', changeset.rollbackTo('task_不存在', 1).error === '没有这条任务')
    check('没给检查点 id → 报错', changeset.rollbackTo(task.id, '').error === '没有给检查点 id')
    check(
      '检查点认不出来 → 报错（不许默默当成 0 号）',
      changeset.rollbackTo(task.id, 9999999999999).error === '没有找到这个检查点',
    )
    check('下标越界也认不出来', changeset.rollbackTo(task.id, 99).ok === false)

    /* ── ⑦ 接线：通道与转出 ───────────────────────────── */
    group('AG-045 / 接线')
    check('changeset 模块转出了 rollbackTo', typeof changeset.rollbackTo === 'function')
    check(
      '老接口还在（drop-in，不动调用方）',
      typeof changeset.rollback === 'function' && typeof changeset.writeMeta === 'function',
    )
    const handlerSrc = readFileSync(join(ROOT, 'electron/handlers/changeset-rollback.cjs'), 'utf8')
    check(
      "handler 注册了 changeset:rollbackTo",
      handlerSrc.includes("ipcMain.handle('changeset:rollbackTo'"),
    )
    check(
      'handler 把 { taskId, checkpointId } 透给内核',
      handlerSrc.includes('payload?.taskId') && handlerSrc.includes('payload?.checkpointId'),
    )
    const safetySrc = readFileSync(join(ROOT, 'electron/handlers/safety.cjs'), 'utf8')
    check(
      'safety.cjs 真的把它注册进去了（光有文件没人调 = 点按钮没反应）',
      /*
       * ⚠️ 别把 require + 相对路径连成一个完整的字符串字面量写在这里 ——
       * 「相对 require 路径都要存在」那条静态检查会把它当成**真的 require**，
       * 然后按本文件所在目录去找，报「路径不存在」。所以只断言后半截。
       */
      safetySrc.includes("changeset-rollback.cjs').register({ ipcMain })"),
    )
  } finally {
    for (const id of tasks) taskCore.remove(id)
    for (const id of sets) rmSync(join(changeset.root(), id), { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
    check(
      '测试任务已清理（不留未完成的垃圾给别的组）',
      tasks.every((id) => taskCore.get(id) === null),
    )
  }
}
