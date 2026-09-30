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
   AG-052：检查点回退的界面入口 —— 干跑预览、说人话的原因、接线钉子

   背景（2026-10-01 端到端验证查出来的）：`changeset:rollbackTo` 内核、handler、
   preload、IPC 清单四处都在，**`src/**` 里零调用点** —— 用户根本点不到它
   （整批撤的「撤销」有入口）。这一组钉的是补上入口时新增的三件事：

   ① `dryRun`（干跑）：确认框要在**动手之前**说清「会撤哪些、会删哪些、哪些撤不动」，
      所以内核得能只算不动。三条铁律：
        · 不动盘（不删文件、不写快照）；
        · 不标事务（否则「预览」自己把事务标成已回滚，接着真撤就撤不动了）；
        · **和真撤同一套判据** —— 预览说 3 个，真撤就得是那 3 个（不许两套说法）。
   ② 失败原因说人话：以前直接把 `error.message` 甩给界面（ENOENT 英文），
      现在走 `errors.cjs` 分类换成中文，原始报错留在 `detail` 里（排查还要用）。
   ③ 接线钉子：preload / handler / 清单 / **界面调用点** / 入口挂在哪 —— 一条都不许掉。

   ⚠️ 判据是毫秒时间戳（检查点的 `at` vs `files[].at`），所以造数据要用真实的
      `tick()` 把「检查点」与「之后的改动」隔开（同毫秒里谁先谁后说不清）。
   ══════════════════════════════════════════════════════════════ */

const SESSION = 'selftest-rollback-preview'
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  const changeset = require(join(ROOT, 'electron/core/changeset.cjs'))
  const taskCore = require(join(ROOT, 'electron/core/task.cjs'))

  const dir = join(SANDBOX, 'rollback-preview')
  mkdirSync(dir, { recursive: true })
  const tasks = []
  const sets = []

  /* 真实的写法是「一个任务一个改动事务」：两次改动都落在同一个事务里 */
  const task = taskCore.create({ goal: '检查点回退的预览', sessionId: SESSION })
  tasks.push(task.id)
  const cs = changeset.begin({ taskId: task.id, sessionId: SESSION, title: '改动' }).id
  sets.push(cs)

  const before = join(dir, 'before.txt')
  const undo = join(dir, 'undo.txt')
  const fresh = join(dir, 'fresh.txt')

  try {
    /* ── 造数据：检查点之前改一次，之后改一个 / 新建一个 / 再改一次 ── */
    writeFileSync(before, '第一版\n', 'utf8')
    changeset.record(cs, before)
    writeFileSync(before, '第一轮改过\n', 'utf8')
    taskCore.checkpoint(task.id, { label: '第 1 轮改动完成' })
    const cp1 = taskCore.get(task.id).checkpoints.at(-1)

    await tick()

    writeFileSync(undo, '原始 undo\n', 'utf8')
    changeset.record(cs, undo)
    writeFileSync(undo, '改坏了\n', 'utf8')
    /* 检查点之前就动过的文件，之后再改一次：record 去重只留第一次的快照 */
    changeset.record(cs, before)
    writeFileSync(before, '第二轮改过\n', 'utf8')
    changeset.record(cs, fresh)
    writeFileSync(fresh, '新文件\n', 'utf8')
    changeset.commit(cs)

    /* ── ① 干跑：只算清单，一个字都不写 ─────────────────── */
    group('AG-052 / 干跑预览：只算清单，不动盘')
    const preview = changeset.rollbackTo(task.id, cp1.at, { dryRun: true })
    check('干跑报告成功', preview.ok === true && preview.dryRun === true, String(preview.error ?? ''))
    check(
      '★ 说清会恢复哪些（检查点之后第一次被改的）',
      preview.restored.join() === undo,
      JSON.stringify(preview.restored),
    )
    check(
      '★ 说清会删哪些（检查点之后新建的）',
      preview.removed.join() === fresh,
      JSON.stringify(preview.removed),
    )
    check(
      '★ 说清哪些撤不动（检查点之前动过、之后又改的），并带原因',
      preview.skipped.some((item) => item.path === before && String(item.reason).length > 0),
      JSON.stringify(preview.skipped),
    )
    check('干跑不动盘：改坏的文件还是改坏的', readFileSync(undo, 'utf8') === '改坏了\n')
    check('干跑不删文件：新建的还在盘上', existsSync(fresh))
    check('干跑不碰「撤不动」的那个', readFileSync(before, 'utf8') === '第二轮改过\n')
    check(
      '★ 干跑不标「已回滚」（标了的话接下来真撤就撤不动了）',
      changeset.readMeta(cs).status === 'committed',
    )
    check('干跑不留 rolledBackAt', !changeset.readMeta(cs).rolledBackAt)
    check(
      '检查点认不出来时干跑也报错（不当成「没有可撤的」）',
      changeset.rollbackTo(task.id, 9999999999999, { dryRun: true }).ok === false,
    )

    /* ── ② 预览 = 实际：同一套判据 ─────────────────────── */
    group('AG-052 / 预览说的就得是真的（同一套判据，不是两套）')
    const real = changeset.rollbackTo(task.id, cp1.at)
    check('真撤带 dryRun:false（界面能分清这次是真动了）', real.dryRun === false)
    check(
      '★ 逐项一致：恢复 / 删除 / 撤不动 / 失败',
      real.restored.join() === preview.restored.join() &&
        real.removed.join() === preview.removed.join() &&
        real.skipped.map((i) => i.path).join() === preview.skipped.map((i) => i.path).join() &&
        real.failed.length === preview.failed.length,
      JSON.stringify({ real: real.restored, preview: preview.restored }),
    )
    check('真撤把文件恢复了', readFileSync(undo, 'utf8') === '原始 undo\n')
    check('真撤把新建的删了', !existsSync(fresh))
    check('撤不动的那个没被碰（拿旧快照顶会把更早的改动一起毁掉）', readFileSync(before, 'utf8') === '第二轮改过\n')
    check(
      '跨检查点的事务不标「已回滚」（还有文件撤不动，留着下次还能接着撤）',
      changeset.readMeta(cs).status === 'committed',
    )

    /* ── ③ 部分失败：原因说人话 ─────────────────────────── */
    group('AG-052 / 恢复失败：原因说人话（不再甩 ENOENT 英文）')
    await tick()
    taskCore.checkpoint(task.id, { label: '准备两个坏掉的事务' })
    const cpLast = taskCore.get(task.id).checkpoints.at(-1)
    await tick()

    const broken = join(dir, 'broken.txt')
    const big = join(dir, 'big.txt')
    writeFileSync(broken, '原始 broken\n', 'utf8')
    writeFileSync(big, '原始 big\n', 'utf8')
    const cs2 = changeset.begin({ taskId: task.id, sessionId: SESSION, title: '会坏掉的改动' }).id
    sets.push(cs2)
    changeset.record(cs2, broken)
    writeFileSync(broken, '改坏的 broken\n', 'utf8')
    changeset.record(cs2, big)
    writeFileSync(big, '改坏的 big\n', 'utf8')
    changeset.commit(cs2)

    const meta2 = changeset.readMeta(cs2)
    /* 一个把快照文件删掉（真丢），一个照着 record() 的写法把「太大没快照」摆出来 */
    rmSync(join(changeset.root(), cs2, 'files', meta2.files[0].snap), { force: true })
    meta2.files[1].snapshot = false
    meta2.files[1].snap = ''
    meta2.files[1].reason = '文件太大，未快照'
    changeset.writeMeta(cs2, meta2)

    const badPreview = changeset.rollbackTo(task.id, cpLast.at, { dryRun: true })
    check(
      '★ 干跑也能看出「撤不回去」（不然确认框会骗人）',
      badPreview.failed.length === 2,
      JSON.stringify(badPreview.failed),
    )

    const bad = changeset.rollbackTo(task.id, cpLast.at)
    const gone = bad.failed.find((item) => item.path === broken)
    check('快照丢了 → 进 failed 点名', Boolean(gone), JSON.stringify(bad.failed))
    check(
      '★ 原因是中文（ENOENT 英文不再甩给用户）',
      String(gone?.reason ?? '').length > 0 && !/ENOENT|no such file/i.test(String(gone?.reason)),
      String(gone?.reason),
    )
    check('原因里说清了是「快照文件不见了」', /快照/.test(String(gone?.reason)), String(gone?.reason))
    check(
      '原始报错没丢（在 detail 里，排查还要用）',
      /ENOENT|no such file/i.test(String(gone?.detail)),
      String(gone?.detail),
    )
    check('带上分类（复用 errors.cjs，不自己再写一套判据）', gone?.kind === 'file_missing', String(gone?.kind))
    const bigOne = bad.failed.find((item) => item.path === big)
    check(
      '本来就没快照的 → 沿用 record() 写的中文原因',
      bigOne?.reason === '文件太大，未快照',
      String(bigOne?.reason),
    )
    check(
      '没恢复成功 → 事务不标「已回滚」（留着还能再试）',
      changeset.readMeta(cs2).status === 'committed',
    )

    /* ── ④ 接线：界面入口真的接上了（F1 的钉子）─────────── */
    group('AG-052 / 接线（preload 有而界面零调用点 = 用户点不到）')
    const core = read('electron/core/changeset-rollback.cjs')
    check(
      '内核用 errors.cjs 分类，不自己再写一套',
      /*
       * ⚠️ 别把 require + 相对路径连成一个完整的字符串字面量写在这里 ——
       * 「相对 require 路径都要存在」那条静态检查会把它当成**真的 require**，
       * 然后按本文件所在目录去找，报「路径不存在」（第一次就是这么红的）。
       */
      core.includes('errors.cjs') && core.includes('errors.classify('),
    )
    check('dryRun 判据严格（传字符串不当真）', core.includes('options?.dryRun === true'))
    check('干跑不写盘（写盘的地方都在 !dryRun 里）', core.includes('!dryRun &&'))
    const handler = read('electron/handlers/changeset-rollback.cjs')
    check('handler 把 dryRun 透给内核', handler.includes('payload?.dryRun === true'))
    check('handler 只给真撤记日志（预览不刷日志）', handler.includes('result.ok && !dryRun'))
    check(
      '★ 通道还在 IPC 清单里（不在的话 preload 调了也会被拒）',
      read('electron/ipc-channels.cjs').includes("'changeset:rollbackTo'"),
    )
    check('preload 仍转出 changesetRollbackTo', read('electron/preload.cjs').includes('changesetRollbackTo'))
    const api = read('src/lib/checkpointRollbackApi.ts')
    check(
      '★ 界面侧有调用点（以前 preload / handler / 清单三处都在，src/** 零调用点）',
      api.includes('changesetRollbackTo'),
    )
    const bar = read('src/components/chat/rollback/CheckpointRollbackBar.tsx')
    check('入口按钮真的调了预览 + 应用', bar.includes('rollbackPreview') && bar.includes('rollbackApply'))
    check('二次确认走应用统一确认框（不自制第二个弹窗）', bar.includes('askPermission'))
    check('确认框给出影响预览', bar.includes('impact'))
    check(
      '★ 按钮写的是全名（名字比能力大就会让人误解）',
      bar.includes('撤销检查点之后的改动'),
    )
    /*
     * 「不许写回那个大名字」放在真渲染的组件测试里（`checkpointRollbackBar.test.tsx`）
     * —— 这里读源码会把注释也扫进去，改句注释就红，是废警报。
     */
    check(
      '入口挂在消息列表末尾（对话结束后下方）',
      read('src/components/chat/MessageList.tsx').includes('CheckpointRollbackBar'),
    )
    check(
      '★ 撤销完在审查面板留记录',
      read('src/components/layout/RightPanel.tsx').includes('RollbackRecord'),
    )
    check(
      '回退记录存在任务快照里（切标签回来还在）',
      read('src/stores/useTaskStore.ts').includes('lastRollback'),
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
