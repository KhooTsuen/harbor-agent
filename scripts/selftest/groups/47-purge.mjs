import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   删对话 → 一并清掉它的任务历史（用户要的）

   原来删对话只删会话文件，任务台账里那些记录会一直留着 —— 任务中心
   越攒越多，而且**点开还能看到已经删掉的对话的任务**（那些任务的 sessionId
   指向一条不存在的对话）。

   这一组管内核这一侧：按 sessionId 整批删，且**只删这一个会话的**。
   界面上「先停在跑的任务、再删、再报条数」那一串在
   `src/stores/__tests__/deleteThreadPurge.test.ts`。
   ══════════════════════════════════════════════════════════════ */

const taskCore = require(join(ROOT, 'electron/core/task.cjs'))

export async function run() {
  const created = []
  const make = (goal, sessionId) => {
    const task = taskCore.create({ goal, sessionId })
    created.push(task.id)
    return task.id
  }

  group('删对话 / 清任务历史')

  const keepSession = 'purge-keep'
  const dropSession = 'purge-drop'
  const doomed = [make('要删的 1', dropSession), make('要删的 2', dropSession), make('要删的 3', dropSession)]
  const kept = make('别动我', keepSession)

  check('删之前能查到 3 条', taskCore.list({ sessionId: dropSession, limit: 50 }).length === 3)

  const result = taskCore.removeBySession(dropSession)
  check('★ 返回删掉的条数', result.removed === 3 && result.ok === true, JSON.stringify(result))
  check('★ 这一条对话的任务查不到了', taskCore.list({ sessionId: dropSession, limit: 50 }).length === 0)
  check(
    '★ 台账里真的没了（不是只从列表里过滤掉）',
    doomed.every((id) => taskCore.get(id) === null),
  )
  check('★ 别的对话的任务一条没动', taskCore.get(kept)?.goal === '别动我')

  /* 空/脏输入不能变成「删全部」 */
  check(
    '★ 空 sessionId 不给删（否则就成了清库）',
    taskCore.removeBySession('').ok === false &&
      taskCore.removeBySession(undefined).removed === 0 &&
      taskCore.get(kept) !== null,
  )
  check('删不存在的会话：返回 0 条，不报错', taskCore.removeBySession('根本没这个').removed === 0)

  /* ── 任务面板里的删除（用户要的按钮）────────────────── */
  group('任务面板 / 删单条 + 清空一组')

  const live = taskCore.create({ goal: '正在跑的', sessionId: keepSession })
  created.push(live.id)
  const doneOne = taskCore.create({ goal: '已完成的一条', sessionId: keepSession })
  created.push(doneOne.id)
  taskCore.finish(doneOne.id, { status: 'completed', result: '做完了' })
  const failedOne = taskCore.create({ goal: '失败的一条', sessionId: keepSession })
  created.push(failedOne.id)
  taskCore.finish(failedOne.id, { status: 'failed', result: '没过' })

  const refused = taskCore.removeSafe(live.id)
  check(
    '★ 正在跑的任务不给删（返回原因，不是静默失败）',
    refused.ok === false && refused.skipped === 1 && Boolean(refused.reason),
    JSON.stringify(refused),
  )
  check('★ 而且它真的还在', taskCore.get(live.id) !== null)
  check('已完成的可以删', taskCore.removeSafe(doneOne.id).ok === true)
  check('删掉了就查不到', taskCore.get(doneOne.id) === null)

  const bulk = taskCore.removeMany({ statuses: ['completed', 'failed', 'running'], sessionId: keepSession })
  check('★ 批量删会跳过正在跑的', bulk.skipped >= 1 && bulk.removed >= 1, JSON.stringify(bulk))
  check('★ 正在跑的那条还在（这正是不许删的）', taskCore.get(live.id) !== null)
  check('失败的那条被删了', taskCore.get(failedOne.id) === null)
  check(
    '别的对话的任务没被连带（清空只作用于这一组 + 这次限定）',
    taskCore.get(kept) !== null,
  )

  /* ── 接线 ───────────────────────────────────────────── */
  group('删对话 / 接线')
  /*
   * deleteThread 从 useAppStore.ts 搬进了 app/threadEdits.ts（那文件本来就管线程编辑，
   * 而 useAppStore 装完项目/导入导出后过 300 行了）。守卫关心的是**行为还在不在**，
   * 所以两个文件合起来看 —— 免得下次搬家又白红一次。
   */
  const storeSrc =
    readFileSync(join(ROOT, 'src/stores/useAppStore.ts'), 'utf8') +
    readFileSync(join(ROOT, 'src/stores/app/threadEdits.ts'), 'utf8')
  check('★ 删对话会清任务历史', storeSrc.includes('taskPurgeBySession(id)'))
  check(
    '★ 顺序：先停掉在跑的任务，再删台账（不然会出现幽灵任务）',
    storeSrc.indexOf('await abortChat(id)') < storeSrc.indexOf('taskPurgeBySession(id)'),
  )
  check('删完把条数返回给调用方（界面要报出来）', storeSrc.includes('return removed'))

  const handlerSrc = readFileSync(join(ROOT, 'electron/handlers/safety.cjs'), 'utf8')
  check('通道注册了 task:purge', handlerSrc.includes("'task:purge'"))
  const channels = readFileSync(join(ROOT, 'electron/ipc-channels.cjs'), 'utf8')
  check('★ 通道清单里有 task:purge（漏了主进程不注册，界面白等）', channels.includes("'task:purge'"))
  const preload = readFileSync(join(ROOT, 'electron/preload.cjs'), 'utf8')
  check('preload 暴露了 taskPurge', preload.includes('taskPurge:'))
  check('★ 单条删除走安全版（内核拦在跑的）', handlerSrc.includes('task.removeSafe'))
  check('★ 批量删通道也注册了', handlerSrc.includes("'task:removeMany'") && channels.includes("'task:removeMany'"))
  const centerSrc = readFileSync(join(ROOT, 'src/components/chat/TaskCenter.tsx'), 'utf8')
  check(
    '★ 在跑 / 等确认的分组没有「清空」按钮',
    centerSrc.includes('LIVE_GROUPS.includes(group.status)'),
  )

  for (const id of created) taskCore.remove(id)
  check('测试任务已清理', created.every((id) => taskCore.get(id) === null))
}
