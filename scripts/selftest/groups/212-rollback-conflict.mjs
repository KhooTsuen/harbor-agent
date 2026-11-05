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
   回滚的覆盖冲突保护（2026-11-06）

   改的是什么：`changeset.rollback(id)` 以前拿到快照就**无条件写回**。于是
   「11 月 1 日那次事务」的快照，可以盖掉此后任何合法改动，界面上只报
   「已撤销，恢复 1 个」——丢的东西看不见。现在写盘之前先判三种冲突，
   命中就**一个字节都不写**，返回冲突清单；用户确认后才带 `force` 真撤。

   判据与「为什么 open 事务不比 mtime」全在
   `electron/core/changeset-conflict.cjs` 的文件头（那边是唯一真相源）。

   这一组钉的八件事（每条都是探针实测过的真实行为，不是推演）：
     ① 正常失败回滚**不许被拦** —— open 事务、之后没人动过 → 照旧恢复
     ② 正常提交后撤销**不许被拦** —— 同一毫秒里刚写完的文件不算「事后被改」
     ③ 更晚的事务改过同一文件 → 拦下，盘上保持那份新内容
     ④ 已提交事务之后用户又改了 → 拦下
     ⑤ 事务新建的文件被删掉又重建 → 拦下，不许删用户那份
     ⑥ 撤销前文件被删了 → 拦下（撤销会把它重建回来）
     ⑦ 拦下时**一个字都不写**：磁盘、meta.status 都不动，之后还撤得动
     ⑧ `force: true` 才真撤 —— 行为与改动前一致
    另加两条接线钉子：界面走的桥必须传 force；冲突卡在界面上真能用。
   ══════════════════════════════════════════════════════════════ */

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const TEXT = (file) => readFileSync(file, 'utf8')

export async function run() {
  const changeset = require(join(ROOT, 'electron/core/changeset.cjs'))
  const taskCore = require(join(ROOT, 'electron/core/task.cjs'))

  const dir = join(SANDBOX, 'rollback-conflict')
  mkdirSync(dir, { recursive: true })
  const tasks = []
  const newTask = (goal) => {
    const task = taskCore.create({ goal, sessionId: 'selftest-rollback-conflict' })
    tasks.push(task.id)
    return task
  }
  const newSet = (task, title = '改动') => {
    const started = changeset.begin({ taskId: task.id, sessionId: task.sessionId, title })
    return started.id
  }

  try {
    /* ── ①② 不许误伤：正常的两条回滚路径 ─────────────────── */
    group('回滚冲突 / 正常回滚不许被拦')

    const t1 = newTask('任务失败后整批撤')
    const f1 = join(dir, 'failed-run.txt')
    writeFileSync(f1, '改之前\n', 'utf8')
    const cs1 = newSet(t1)
    changeset.record(cs1, f1)
    writeFileSync(f1, '改坏了\n', 'utf8')
    /* 不 commit —— 任务失败/中断后事务就停在这儿（这是最主要的正常用法） */
    const r1 = changeset.rollback(cs1)
    check('任务失败后整批撤照旧能撤（open 事务不比 mtime）', r1.ok === true && !r1.blocked, JSON.stringify(r1.conflicts ?? []))
    check('内容真的回到改之前', TEXT(f1) === '改之前\n', TEXT(f1))

    const t2 = newTask('提交后正常撤')
    const f2 = join(dir, 'plain.txt')
    writeFileSync(f2, 'v1\n', 'utf8')
    const cs2 = newSet(t2)
    changeset.record(cs2, f2)
    writeFileSync(f2, 'v2-agent\n', 'utf8')
    changeset.commit(cs2, { verified: true })
    const r2 = changeset.rollback(cs2)
    check(
      '刚提交就撤不许被拦（同一毫秒写完的文件不算「事后被改」）',
      r2.ok === true && r2.blocked !== true,
      JSON.stringify(r2.conflicts ?? []),
    )
    check('提交后撤回得去', TEXT(f2) === 'v1\n', TEXT(f2))

    /* ── ③ 更晚的事务动过同一文件 ────────────────────────── */
    group('回滚冲突 / 更晚的事务改过同一文件')
    const t3 = newTask('旧事务 A')
    const f3 = join(dir, 'shared.txt')
    writeFileSync(f3, 'v1\n', 'utf8')
    const csA = newSet(t3, 'A')
    changeset.record(csA, f3)
    writeFileSync(f3, 'v2-A\n', 'utf8')
    changeset.commit(csA, { verified: true })

    const t3b = newTask('新事务 B')
    const csB = newSet(t3b, 'B')
    changeset.record(csB, f3)
    writeFileSync(f3, 'v3-B\n', 'utf8')
    changeset.commit(csB, { verified: true })

    const r3 = changeset.rollback(csA)
    check('★ 撤销旧事务被拦下', r3.ok === true && r3.blocked === true, JSON.stringify(r3))
    check(
      '冲突类型是「之后被另一次改动改过」',
      r3.conflicts?.[0]?.kind === 'later_changeset',
      JSON.stringify(r3.conflicts),
    )
    check('★ B 的成果一个字都没被盖掉', TEXT(f3) === 'v3-B\n', TEXT(f3))
    check('被拦下时盘上没写任何东西', r3.restored.length === 0 && r3.removed.length === 0)
    check(
      '★ 被拦下时事务状态保持不变（用户取消后还撤得动）',
      changeset.readMeta(csA).status === 'committed',
      changeset.readMeta(csA).status,
    )

    /* ── ⑧ 用户确认后强撤 ────────────────────────────────── */
    group('回滚冲突 / 用户确认后覆盖')
    const forced = changeset.rollback(csA, { force: true })
    check('★ force 之后才真撤', forced.ok === true && !forced.blocked && forced.restored.length === 1)
    check('强撤确实回到旧内容（与改动前行为一致）', TEXT(f3) === 'v1\n', TEXT(f3))
    check('强撤后事务标成已回滚', changeset.readMeta(csA).status === 'rolled-back')

    /* ── ④ 已提交事务之后用户手改 ────────────────────────── */
    group('回滚冲突 / 事务结束后被手动改过')
    const t4 = newTask('之后被手改')
    const f4 = join(dir, 'hand-edited.txt')
    writeFileSync(f4, 'v1\n', 'utf8')
    const cs4 = newSet(t4)
    changeset.record(cs4, f4)
    writeFileSync(f4, 'v2-agent\n', 'utf8')
    changeset.commit(cs4, { verified: true })
    /* 事务收尾之后（mtime 更晚）用户自己又改了一次。
       ★ 要隔开超过内核的 `MTIME_SLACK_MS`（50ms）：那 50ms 是 Windows 时钟粒度的余量，
         这期间的改动内核判不出来（盲区，见 changeset-conflict.cjs 的常量注释）。
         真实使用里「事务收尾 → 用户手改 → 再点撤销」不会落在 50ms 里。 */
    await new Promise((resolve) => setTimeout(resolve, 120))
    writeFileSync(f4, 'v3-用户自己改的\n', 'utf8')

    const r4 = changeset.rollback(cs4)
    check('★ 事务结束后的手改也拦下', r4.blocked === true, JSON.stringify(r4.conflicts))
    check('冲突类型是「之后被改过」', r4.conflicts?.[0]?.kind === 'modified_after')
    check('用户那份内容还在', TEXT(f4) === 'v3-用户自己改的\n', TEXT(f4))

    /* ── ⑤ 新建的文件被删掉又重建 ────────────────────────── */
    group('回滚冲突 / 新建的文件被删掉又重建')
    const t5 = newTask('新建后被重建')
    const f5 = join(dir, 'recreated.txt')
    const cs5 = newSet(t5)
    changeset.record(cs5, f5) /* 不存在 → 事务里记的是「新建」 */
    writeFileSync(f5, 'agent 建的\n', 'utf8')
    changeset.commit(cs5, { verified: true })
    await new Promise((resolve) => setTimeout(resolve, 120))
    rmSync(f5, { force: true })
    writeFileSync(f5, '用户建的\n', 'utf8')

    const r5 = changeset.rollback(cs5)
    check('★ 不许直接删用户的文件', r5.blocked === true, JSON.stringify(r5.conflicts))
    check('冲突类型是「新建的又被重建」', r5.conflicts?.[0]?.kind === 'recreated')
    check('用户的文件还在、内容没变', existsSync(f5) && TEXT(f5) === '用户建的\n')

    /* ── ⑥ 撤销前文件已被删除 ────────────────────────────── */
    group('回滚冲突 / 撤销前文件已被删除')
    const t6 = newTask('文件被删了')
    const f6 = join(dir, 'deleted.txt')
    writeFileSync(f6, 'v1\n', 'utf8')
    const cs6 = newSet(t6)
    changeset.record(cs6, f6)
    writeFileSync(f6, 'v2\n', 'utf8')
    changeset.commit(cs6, { verified: true })
    await new Promise((resolve) => setTimeout(resolve, 120))
    rmSync(f6, { force: true })

    const r6 = changeset.rollback(cs6)
    check('★ 撤销会把删掉的文件重建回来 —— 得先问', r6.blocked === true, JSON.stringify(r6.conflicts))
    check('冲突类型是「之后被删了」', r6.conflicts?.[0]?.kind === 'deleted_after')
    check('没有偷偷把它建回来', !existsSync(f6))

    /* ── 空事务 / 不存在的事务 ───────────────────────────── */
    group('回滚冲突 / 边界')
    const t7 = newTask('空事务')
    const cs7 = newSet(t7)
    const r7 = changeset.rollback(cs7)
    check('空事务照常成功（没有文件就没有冲突可判）', r7.ok === true && !r7.blocked)
    const missing = changeset.rollback('cs_不存在')
    check('不存在的事务仍然报「事务不存在」', missing.ok === false && missing.error === '事务不存在')

    /* 容差本身也钉住 —— 它是量出来的（tmp/probe-mtime-grain.cjs：Windows 上
       writeFileSync 后 mtime 比 Date.now() 最多大 1.17ms），放宽到秒级会把真冲突全漏掉 */
    const conflictCore = require(join(ROOT, 'electron/core/changeset-conflict.cjs'))
    check(
      '容差在 10~500ms 之间（够盖住时钟粒度、又不至于漏掉真实改动）',
      conflictCore.MTIME_SLACK_MS >= 10 && conflictCore.MTIME_SLACK_MS <= 500,
      String(conflictCore.MTIME_SLACK_MS),
    )
    check(
      '容差判据：刚好等于容差不算「更晚」',
      conflictCore.laterThanSettled(1000 + conflictCore.MTIME_SLACK_MS, 1000) === false,
    )
    check(
      '容差判据：超过 1ms 就算「更晚」',
      conflictCore.laterThanSettled(1000 + conflictCore.MTIME_SLACK_MS + 1, 1000) === true,
    )

    /* ── ⑦ 只有一处真相源：判据不许在 handler 里重写一遍 ──── */
    group('回滚冲突 / 接线')
    const handler = read('electron/handlers/changeset.cjs')
    check(
      '★ handler 把 force 传给内核',
      handler.includes('force: payload.force === true'),
      '界面点了「仍然撤销」却传不下去，就等于永远只能被拦',
    )
    check('handler 不自己判冲突（判据只在内核一处）', !handler.includes('mtimeMs'))
    const preload = read('electron/preload.cjs')
    check(
      '★ preload 把整个 payload 传下去（老的字符串形状不该再写死）',
      preload.includes("changesetRollback: (payload) => call('changeset:rollback', payload)"),
    )
    const flow = read('src/components/chat/changesetRollbackFlow.ts')
    check('★ 界面上有「仍然撤销」这个出口（不能只报个错就完）', flow.includes("confirmText: '仍然撤销（覆盖）'"))
    check('强撤那条路真的带 force', flow.includes('changesetRollback(changeset.id, { force: true })'))
    check(
      '冲突卡是破坏性确认（走居中弹窗 + 红按钮那条）',
      flow.includes("kind: 'rollback-changeset'") && flow.includes('danger: true'),
    )
    const sfSafety = read('src/lib/safetyApi.ts')
    check(
      '老的 import 路径没断（safetyApi 原样转出）',
      sfSafety.includes("export { changesetList, changesetRollback } from './changesetApi'"),
    )
  } finally {
    /* 先把状态改成 cancelled 再删 —— create 出来的任务默认是 running，removeSafe 会拒 */
    for (const id of tasks) {
      if (!taskCore.get(id)) continue
      taskCore.update(id, { status: 'cancelled' })
      taskCore.removeSafe(id)
    }
    rmSync(dir, { recursive: true, force: true })
  }
}
