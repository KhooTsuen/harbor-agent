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
   回退到检查点：覆盖冲突保护（2026-11-07）

   改的是什么：`rollbackTo` 以前**一条判定都没有** —— 拿到快照就无条件写回。
   于是「11 月 1 日那次检查点」之后的任何合法改动（用户手改的、后面几轮改的）
   都能被一下盖掉，界面还报「恢复 N 个」。整批撤销 `rollback(id)` 有这套保护
   （212 组钉着），这条一直没有。

   判据与「为什么 open 事务不比 mtime」在 `changeset-conflict.cjs` 的文件头
   （那边是唯一真相源，这里不重写一份）。本组只钉**回退路径**接上去之后的八件事：

     ① 没冲突 → 正常撤（对照组：不许因为加判定就变成永远拦）
     ② 检查点之后用户手改了那个文件 → 拦下，盘上保持用户那份
     ③ 连续多个事务改同一文件（都在检查点之后）→ **不许**误拦，正常全撤
     ④ 原文件被删 / 事务新建的文件被删又重建 → 拦下
     ⑤ 多文件里只要一个冲突 → 整体拦下，**另一个也不许先写**
     ⑥ 恢复失败（快照丢了）→ `ok:false` 且进 `failed`（G5）
     ⑦ `force: true` 才真盖，且只盖该盖的
     ⑧ `rollback(id)` 行为不退化（老接口一个字节都不变）

   ⚠️ 判据是毫秒时间戳，组里用真实的 `tick()` 把「检查点」与「之后的改动」隔开。
   ⚠️ 只在本组自己的 SANDBOX 工作区里造文件，不碰任何真实项目。
   ══════════════════════════════════════════════════════════════ */

const SESSION = 'selftest-rollback-to-conflict'

/** 检查点与改动之间隔一次真实的时钟跳动（同一毫秒说不清谁先谁后） */
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

/**
 * 造「事务收尾**之后**别人又动过」时必须等过容差（`changeset-conflict.MTIME_SLACK_MS` = 50ms）。
 * 只等 10ms 的话 mtime 落在容差里，判据认不出「事后被改」—— 那是测试造数不真，不是产品没拦。
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 120))

export async function run() {
  const changeset = require(join(ROOT, 'electron/core/changeset.cjs'))
  const taskCore = require(join(ROOT, 'electron/core/task.cjs'))

  const dir = join(SANDBOX, 'rollback-to-conflict')
  mkdirSync(dir, { recursive: true })
  const tasks = []
  const sets = []

  const newTask = (goal) => {
    const task = taskCore.create({ goal, sessionId: SESSION })
    tasks.push(task.id)
    return task
  }
  const begin = (task) => {
    const taskId = task?.id ?? String(task)
    const started = changeset.begin({ taskId, title: '改动' })
    if (started?.id) sets.push(started.id)
    return started?.id ?? ''
  }
  const lastCp = (taskId) => (taskCore.get(taskId)?.checkpoints ?? []).at(-1)

  /** 造一个「检查点之后的改动」：写文件 → record → 再改 → commit */
  const changeAfter = async (taskId, file, before, after) => {
    await tick()
    writeFileSync(file, before, 'utf8')
    const id = begin(taskId)
    sets.push(id)
    changeset.record(id, file)
    writeFileSync(file, after, 'utf8')
    changeset.commit(id)
    return id
  }

  try {
    /* ══ ① 无冲突：正常撤（对照组） ══ */
    group('① 没有冲突 → 正常回退')
    const t1 = newTask('无冲突')
    const f1 = join(dir, 'plain.txt')
    writeFileSync(f1, '原始\n', 'utf8')
    await tick()
    taskCore.checkpoint(t1.id, { label: '起点' })
    await changeAfter(t1.id, f1, '原始\n', '改过\n')
    const ok1 = changeset.rollbackTo(t1.id, lastCp(t1.id).at)
    check('★ 没有冲突就照常撤（不是永远拦）', ok1.ok === true && !ok1.blocked, JSON.stringify(ok1.conflicts))
    check('文件真的回到检查点之前', readFileSync(f1, 'utf8') === '原始\n', readFileSync(f1, 'utf8'))

    /* ══ ② 检查点之后用户手改 → 拦下 ══ */
    group('② 检查点之后用户又改过那个文件')
    const t2 = newTask('用户手改')
    const f2 = join(dir, 'manual.txt')
    writeFileSync(f2, '原始\n', 'utf8')
    await tick()
    taskCore.checkpoint(t2.id, { label: '起点' })
    await changeAfter(t2.id, f2, '原始\n', 'Agent 改的\n')
    /* 用户自己动手（mtime 必须晚过容差，否则判据认不出来 —— 见 settle 的说明） */
    await settle()
    writeFileSync(f2, '用户手改的\n', 'utf8')
    const blocked2 = changeset.rollbackTo(t2.id, lastCp(t2.id).at)
    check('★★ 拦下（blocked）', blocked2.ok === false && blocked2.blocked === true, JSON.stringify(blocked2.conflicts))
    check('★★ 盘上保持用户那份（没被静默覆盖）', readFileSync(f2, 'utf8') === '用户手改的\n', readFileSync(f2, 'utf8'))
    check('冲突项带路径与原因', blocked2.conflicts.length === 1 && String(blocked2.conflicts[0].reason ?? '').length > 0, JSON.stringify(blocked2.conflicts))
    check('★ 拦下时一个字都没写（清单全空）', blocked2.restored.length === 0 && blocked2.removed.length === 0)

    /* ══ ③ 连续多个事务改同一文件 → 不许误拦 ══ */
    group('③ 连续多轮改同一文件（都在检查点之后）')
    const t3 = newTask('连续改')
    const f3 = join(dir, 'seq.txt')
    writeFileSync(f3, 'v0\n', 'utf8')
    await tick()
    taskCore.checkpoint(t3.id, { label: '起点' })
    await changeAfter(t3.id, f3, 'v0\n', 'v1\n')
    await changeAfter(t3.id, f3, 'v1\n', 'v2\n')
    await changeAfter(t3.id, f3, 'v2\n', 'v3\n')
    const ok3 = changeset.rollbackTo(t3.id, lastCp(t3.id).at)
    check('★★ 不许误拦（三个事务都要撤，它们互相更晚是正常的）', ok3.ok === true && !ok3.blocked, JSON.stringify(ok3.conflicts))
    check('★ 撤完回到 v0', readFileSync(f3, 'utf8') === 'v0\n', readFileSync(f3, 'utf8'))
    check('三个事务都进了清单', ok3.changesets.length === 3, String(ok3.changesets.length))

    /* ══ ④ 文件被删 / 新建的被删又重建 → 拦下 ══ */
    group('④ 文件在检查点之后被删掉')
    const t4 = newTask('被删')
    const f4 = join(dir, 'deleted.txt')
    writeFileSync(f4, '原始\n', 'utf8')
    await tick()
    taskCore.checkpoint(t4.id, { label: '起点' })
    await changeAfter(t4.id, f4, '原始\n', '改过\n')
    await settle()
    rmSync(f4, { force: true })
    const blocked4 = changeset.rollbackTo(t4.id, lastCp(t4.id).at)
    check('★★ 文件不见了 → 拦下（撤销会把它重建回来）', blocked4.blocked === true, JSON.stringify(blocked4.conflicts))
    check('★ 没有把文件凭空建回来', !existsSync(f4))

    group('④′ 事务新建的文件被删掉又重建')
    const t4b = newTask('重建')
    await tick()
    taskCore.checkpoint(t4b.id, { label: '起点' })
    const f4b = join(dir, 'recreated.txt')
    await tick()
    const csB = begin(t4b.id)
    sets.push(csB)
    changeset.record(csB, f4b) /* 记「本来不存在」 */
    writeFileSync(f4b, 'Agent 建的\n', 'utf8')
    changeset.commit(csB)
    await settle()
    rmSync(f4b, { force: true })
    await settle()
    writeFileSync(f4b, '用户自己建的\n', 'utf8')
    const blocked4b = changeset.rollbackTo(t4b.id, lastCp(t4b.id).at)
    check('★★ 拦下（撤销会删掉用户那份）', blocked4b.blocked === true, JSON.stringify(blocked4b.conflicts))
    check('★★ 用户那份还在', readFileSync(f4b, 'utf8') === '用户自己建的\n', readFileSync(f4b, 'utf8'))

    /* ══ ⑤ 多文件里一个冲突 → 整体拦下 ══ */
    group('⑤ 多文件回退，其中只有一个冲突')
    const t5 = newTask('多文件')
    const fa = join(dir, 'multi-a.txt')
    const fb = join(dir, 'multi-b.txt')
    writeFileSync(fa, 'A0\n', 'utf8')
    writeFileSync(fb, 'B0\n', 'utf8')
    await tick()
    taskCore.checkpoint(t5.id, { label: '起点' })
    await tick()
    const cs5 = begin(t5.id)
    sets.push(cs5)
    changeset.record(cs5, fa)
    changeset.record(cs5, fb)
    writeFileSync(fa, 'A1\n', 'utf8')
    writeFileSync(fb, 'B1\n', 'utf8')
    changeset.commit(cs5)
    /* 只有 b 被用户动过 */
    await settle()
    writeFileSync(fb, 'B-用户\n', 'utf8')
    const blocked5 = changeset.rollbackTo(t5.id, lastCp(t5.id).at)
    check('★★ 整体拦下', blocked5.blocked === true, JSON.stringify(blocked5.conflicts))
    check('★★ 没冲突的那个文件也**没被先写**（不许撤一半）', readFileSync(fa, 'utf8') === 'A1\n', readFileSync(fa, 'utf8'))
    check('★ 冲突只报了 b 一个', blocked5.conflicts.length === 1 && blocked5.conflicts[0].path === fb, JSON.stringify(blocked5.conflicts.map((c) => c.path)))

    /* ══ ⑥ 恢复失败 → ok:false（G5） ══ */
    group('⑥ 快照丢了：ok 必须是 false')
    const t6 = newTask('坏快照')
    const f6 = join(dir, 'broken.txt')
    writeFileSync(f6, '原始\n', 'utf8')
    await tick()
    taskCore.checkpoint(t6.id, { label: '起点' })
    await changeAfter(t6.id, f6, '原始\n', '改过\n')
    const meta6 = changeset.readMeta(sets.at(-1))
    rmSync(join(changeset.root(), sets.at(-1), 'files', meta6.files[0].snap), { force: true })
    const failed6 = changeset.rollbackTo(t6.id, lastCp(t6.id).at)
    check('★★ ok:false（不许把部分回退报成成功）', failed6.ok === false, JSON.stringify({ ok: failed6.ok }))
    check('★ 不是被冲突拦的（是真的失败了）', failed6.blocked === false)
    check('★ 失败项进 failed 且带原因', failed6.failed.length === 1 && String(failed6.failed[0].reason ?? '').length > 0, JSON.stringify(failed6.failed))

    /* ══ ⑦ force 才真盖 ══ */
    group('⑦ force:true 才真撤')
    const t7 = newTask('强撤')
    const f7 = join(dir, 'force.txt')
    writeFileSync(f7, '原始\n', 'utf8')
    await tick()
    taskCore.checkpoint(t7.id, { label: '起点' })
    await changeAfter(t7.id, f7, '原始\n', 'Agent 改的\n')
    await settle()
    writeFileSync(f7, '用户改的\n', 'utf8')
    const forced = changeset.rollbackTo(t7.id, lastCp(t7.id).at, { force: true })
    check('★★ 带 force 才真撤', forced.ok === true && forced.forced === true, JSON.stringify({ ok: forced.ok }))
    check('★ 真盖成了（用户那份被覆盖 —— 这是他自己确认过的）', readFileSync(f7, 'utf8') === '原始\n', readFileSync(f7, 'utf8'))
    check('★ 冲突清单仍然如实带回来（界面要显示盖了什么）', Array.isArray(forced.conflicts))

    /* ══ ⑧ 老接口不退化 ══ */
    group('⑧ rollback(id) 行为不退化')
    const t8 = newTask('整批撤')
    const f8 = join(dir, 'whole.txt')
    writeFileSync(f8, '原始\n', 'utf8')
    const cs8 = begin(t8.id)
    sets.push(cs8)
    changeset.record(cs8, f8)
    writeFileSync(f8, '改过\n', 'utf8')
    changeset.commit(cs8)
    const whole = changeset.rollback(cs8)
    check('★ 整批撤照旧成功', whole.ok === true && whole.restored.length === 1 && whole.blocked === false, JSON.stringify(whole))
    check('★ 文件恢复', readFileSync(f8, 'utf8') === '原始\n')
    check('★ 事务标成已回滚', changeset.readMeta(cs8).status === 'rolled-back')

    /* `inspect` 不传 options 时行为不变（整批撤销走的就是这条） */
    const t8b = newTask('整批撤冲突')
    const f8b = join(dir, 'whole2.txt')
    writeFileSync(f8b, '原始\n', 'utf8')
    const cs8b = begin(t8b.id)
    sets.push(cs8b)
    changeset.record(cs8b, f8b)
    writeFileSync(f8b, '改过\n', 'utf8')
    changeset.commit(cs8b)
    await settle()
    writeFileSync(f8b, '用户改的\n', 'utf8')
    const wholeBlocked = changeset.rollback(cs8b)
    check('★★ 整批撤的冲突保护仍然生效', wholeBlocked.blocked === true, JSON.stringify(wholeBlocked.conflicts))
    check('★ 用户那份没被盖', readFileSync(f8b, 'utf8') === '用户改的\n', readFileSync(f8b, 'utf8'))

    /* ══ 接线：handler 透 force ══ */
    group('⑨ 接线')
    const handlerSrc = readFileSync(join(ROOT, 'electron/handlers/changeset-rollback.cjs'), 'utf8')
    check('★ handler 透 force 给内核', handlerSrc.includes('payload?.force'))
    check('★ handler 把 force 传进 rollbackTo 的 options', /rollbackTo\([^)]*\{[^}]*force\s*[,}]/s.test(handlerSrc))
    check('★ handler 在被拦时记日志（不静默）', handlerSrc.includes('blocked'))

    /*
     * ── 恢复单个文件必须走原子写（2026-11-10 静态核对发现）──
     * 以前 `restoreOne` 用 `writeFileSync` 直接覆盖：写到一半失败（磁盘满 / 被占着）
     * 会**把用户文件截断成半截**。而「回退失败后还能安全重试」的前提恰恰是
     * 目标要么旧内容、要么新内容，绝不能是半截。项目里早有 safe-write.cjs，这处漏用了。
     */
    group('⑩ 恢复走原子写')
    const rbSrc = readFileSync(join(ROOT, 'electron/core/changeset-rollback.cjs'), 'utf8')
    check('★★★ 恢复单个文件用 writeAtomic（不是裸 writeFileSync）', /writeAtomic\(entry\.path/.test(rbSrc))
    check(
      '★★★ 恢复路径里不再有裸 writeFileSync 覆盖目标文件',
      !/fs\.writeFileSync\(entry\.path/.test(rbSrc),
    )
    /* 不用 `require('./safe-write.cjs')` 这个整串做断言：源码守卫会把字符串字面量
       当成真的相对 require 去查文件（217 组自己就吃过一次误报）。这里只认模块名。 */
    check(
      '★ 原子写从 safe-write.cjs 引入（唯一实现，不另写一份）',
      /safe-write\.cjs/.test(rbSrc) && /writeAtomic/.test(rbSrc),
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
