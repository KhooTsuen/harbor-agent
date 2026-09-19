import {
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
   AG-036 后半：「未提交的改动」算成 diff

   右栏「审查」标签一直有界面却没有数据 —— 类型里有 `message.diffs`、
   `RightPanel` 也汇总渲染，但真实流程里没人写过它，于是永远显示
   「没有待审查的改动」，而那时 Agent 明明刚改过文件。

   数据一直在：改动事务**改之前**存了快照（回滚靠它）。这里比
   「快照 vs 磁盘现在的样子」，三种情况都得说清楚：

     · 改过的文件 → 快照 vs 现在
     · 新建的文件 → 没有快照，全是新增
     · 被删的文件 → 现在读不到，整篇删除
     · 快照丢了 / 一次改太多 → **不算进 diff，但要说一句**（不许悄悄少文件）
   ══════════════════════════════════════════════════════════════ */

const changeset = require(join(ROOT, 'electron/core/changeset.cjs'))
const changesetDiff = require(join(ROOT, 'electron/core/changeset-diff.cjs'))

const SESSION = 'selftest-ag036b'

export async function run() {
  const dir = join(SANDBOX, 'ag036b')
  mkdirSync(dir, { recursive: true })
  const created = []
  function begin() {
    const started = changeset.begin({
      taskId: 'task_ag036b',
      sessionId: SESSION,
      title: '改几个文件',
    })
    created.push(started.id)
    return started.id
  }

  try {
    /* ── ① 改过的文件 ───────────────────────────────────── */
    group('AG-036b / 改过的文件')
    const target = join(dir, 'app.txt')
    const fresh = join(dir, 'new.txt')
    const gone = join(dir, 'gone.txt')
    writeFileSync(target, ['一', '二', '三', ''].join('\n'), 'utf8')
    writeFileSync(gone, ['甲', '乙', ''].join('\n'), 'utf8')

    const id = begin()
    /* 事务的规矩：**改之前**记快照 */
    changeset.record(id, target)
    changeset.record(id, gone)
    changeset.record(id, fresh) /* 还不存在 = 新建 */

    writeFileSync(target, ['一', '二改', '三', ''].join('\n'), 'utf8')
    writeFileSync(fresh, ['新文件第一行', ''].join('\n'), 'utf8')
    rmSync(gone, { force: true })

    const diff = changesetDiff.diffOf(id)
    check('算得出 diff', diff.ok === true && diff.files.length === 3, String(diff.files?.length))
    const byName = Object.fromEntries(diff.files.map((f) => [f.path.split(/[\\/]/).pop(), f]))
    check(
      '改过的文件 +1 −1',
      byName['app.txt']?.additions === 1 && byName['app.txt']?.deletions === 1,
    )
    check(
      '新建的文件全是新增',
      byName['new.txt']?.additions === 1 && byName['new.txt']?.deletions === 0,
    )
    check(
      '被删的文件没有新增行',
      byName['gone.txt']?.additions === 0,
      String(byName['gone.txt']?.additions),
    )
    check(
      '被删的文件行数算进了删除',
      byName['gone.txt']?.deletions === 2,
      String(byName['gone.txt']?.deletions),
    )
    check(
      '总数是各项相加',
      diff.additions === 2 && diff.deletions === 3,
      `${diff.additions}/${diff.deletions}`,
    )
    check('带上是谁的改动（会话 id）', diff.sessionId === SESSION)
    check('带上标题', diff.title === '改几个文件')
    check('没算进 diff 的文件要有说明（这次没有）', Array.isArray(diff.skipped))

    /* ── ② 净效果为零的不显示 ───────────────────────────── */
    group('AG-036b / 没有净变化就不显示')
    const same = join(dir, 'same.txt')
    writeFileSync(same, '原样\n', 'utf8')
    const id2 = begin()
    changeset.record(id2, same)
    /* 改了又改回去（或者根本没改）—— 用户不该看到「改了 0 行」的影子 */
    check('改回去的文件不进列表', changesetDiff.diffOf(id2).files.length === 0)

    const id3 = begin()
    changeset.record(id3, join(dir, 'made-then-removed.txt'))
    check('新建了又删掉 → 不进列表', changesetDiff.diffOf(id3).files.length === 0)

    /* ── ③ 快照丢了要说出来 ─────────────────────────────── */
    group('AG-036b / 快照读不到不许悄悄少文件')
    const lost = join(dir, 'lost.txt')
    writeFileSync(lost, '内容\n', 'utf8')
    const id4 = begin()
    changeset.record(id4, lost)
    writeFileSync(lost, '改过了\n', 'utf8')
    /* 手动把快照删掉，模拟「快照丢了」 */
    const meta = changeset.readMeta(id4)
    rmSync(join(changeset.root(), id4, 'files', meta.files[0].snap), { force: true })
    const lostDiff = changesetDiff.diffOf(id4)
    check(
      '算不出来就说出来（skipped 里有它）',
      lostDiff.skipped.length === 1,
      JSON.stringify(lostDiff.skipped),
    )
    check(
      'skipped 里点名了哪个文件',
      lostDiff.skipped[0]?.includes ? lostDiff.skipped[0].includes('lost.txt') : false,
      lostDiff.skipped[0],
    )

    /* ── ④ latest：取最近一次有改动的 ───────────────────── */
    group('AG-036b / 最近一次有改动的事务')
    const newest = begin()
    const newestFile = join(dir, `newest-${Date.now()}.txt`)
    changeset.record(newest, newestFile)
    writeFileSync(newestFile, '最新的改动\n', 'utf8')
    const empty = begin()
    const latest = changesetDiff.latest({ sessionId: SESSION })
    check('★ latest 给的是最近那次', latest.id === newest, `${latest.id} vs ${newest}`)
    check(
      '★ 空事务会被跳过（要的是「最近那个**有改动的**」，不是「最近那个」）',
      latest.id !== empty && latest.files.length === 1,
      latest.id,
    )

    check(
      '★ 别的会话的改动不会串进来',
      changesetDiff.latest({ sessionId: '别的会话' }).files.length === 0,
    )
    check('纯读：算 diff 不改事务状态', changeset.readMeta(newest).status === 'open')

    /* ── ⑤ 接线：IPC 通道送回渲染层 ─────────────────────── */
    group('AG-036b / 接线（IPC 送回渲染层）')
    const channels = readFileSync(join(ROOT, 'electron/ipc-channels.cjs'), 'utf8')
    check('通道清单里有 changeset:diff', channels.includes("'changeset:diff'"))
    const handlers = readFileSync(join(ROOT, 'electron/handlers/safety.cjs'), 'utf8')
    check('handler 真的注册了', handlers.includes("ipcMain.handle('changeset:diff'"))
    check('handler 走的是 changesetDiff.latest', handlers.includes('changesetDiff.latest('))
    const preload = readFileSync(join(ROOT, 'electron/preload.cjs'), 'utf8')
    check('preload 暴露了 changesetDiff', preload.includes('changesetDiff:'))

    /* ── ⑥ 前端：右栏与顶栏读的是同一份 ─────────────────── */
    group('AG-036b / 前端接线')
    const store = readFileSync(join(ROOT, 'src/stores/useTaskStore.ts'), 'utf8')
    check(
      '★ store 里拉了 diff',
      store.includes('changesetDiff(useAppStore.getState().activeThreadId)'),
    )
    const panel = readFileSync(join(ROOT, 'src/components/layout/RightPanel.tsx'), 'utf8')
    check('★ 右栏不再从消息里翻 message.diffs', !panel.includes('flatMap((m) => m.diffs'))
    check('右栏读 store 的 diff', panel.includes('useTaskStore((s) => s.diff)'))
    const title = readFileSync(join(ROOT, 'src/components/layout/AppTitleBar.tsx'), 'utf8')
    check('★ 顶栏也读同一份（不再各算一套）', title.includes('useTaskStore((s) => s.diff)'))
  } finally {
    for (const id of created) rmSync(join(changeset.root(), id), { recursive: true, force: true })
  }
}
