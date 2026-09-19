import { join, readFileSync, require, rmSync, ROOT, writeFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-039：后台执行隔离 —— 任务索引

   文档要求「LLM / Shell / PTY / Search / MCP / Tools / Agent Loop 不阻塞
   输入 / 切对话 / 设置 / 导航 / UI 渲染」。

   渲染层是独立进程，重活本来就在主进程 —— 但主进程被按住同样会让整个应用发木：
   **列任务原来是「把 data/tasks 下每个 JSON 全读一遍」**（1241 个实测 240ms），
   而这份列表在**每个工具跑完**时都会被刷新一次。于是「Agent 干得越多，主进程
   被按住越久」，IPC、窗口事件、托盘菜单全排在那 240ms 后面。

   修法：索引（谁写谁更新）+ 只在读路径校验目录。这一组盯：

     · 索引**准确**（写/改/删都跟着走；外部改动能被发现；坏了能重建）
     · 索引**是加速不是真相源**（坏了、删了都不影响功能）
     · ★ **不再全表通读**（数 readFileSync 次数，比计时稳）
   ══════════════════════════════════════════════════════════════ */

const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const taskIndex = require(join(ROOT, 'electron/core/task-index.cjs'))
const taskIo = require(join(ROOT, 'electron/core/task-io.cjs'))
const fs = require('node:fs')

export async function run() {
  const created = []
  const SESSION = 'selftest-ag039'
  function newTask(goal = '索引测试', patch = {}) {
    const task = taskCore.create({ goal, sessionId: SESSION })
    created.push(task.id)
    if (Object.keys(patch).length > 0) taskCore.update(task.id, patch)
    return taskCore.get(task.id)
  }
  const cleanup = () => {
    for (const id of created) taskCore.remove(id)
  }

  try {
    /* ── ① 索引准不准 ─────────────────────────────────── */
    group('AG-039 / 索引跟着写走')
    taskIndex.reset()
    const a = newTask('甲')
    check(
      '新建的任务立刻能列出来',
      taskCore.list({ limit: 5000 }).some((t) => t.id === a.id),
    )

    taskCore.update(a.id, { title: '甲（改过）' })
    const listed = taskCore.list({ limit: 5000 }).find((t) => t.id === a.id)
    check('改了标题，列表里也是新的', listed?.title === '甲（改过）', listed?.title)

    taskCore.finish(a.id, { status: 'completed', result: 'done' })
    check(
      '状态跟着走（按状态过滤能查到）',
      taskCore.list({ status: 'completed', limit: 5000 }).some((t) => t.id === a.id),
    )

    const b = newTask('乙')
    taskCore.remove(b.id)
    check(
      '删掉的任务立刻从列表消失',
      taskCore.list({ limit: 5000 }).every((t) => t.id !== b.id),
    )
    /* 清理数组里也别再删第二次 */
    created.splice(created.indexOf(b.id), 1)

    /* ── ② 索引是加速，不是真相源 ─────────────────────── */
    group('AG-039 / 索引坏了也不影响功能')
    const indexFile = taskIndex.indexFile()
    const backup = readFileSync(indexFile, 'utf8')
    writeFileSync(indexFile, '{ 这不是 JSON', 'utf8')
    taskIndex.reset()
    const afterBroken = taskCore.list({ limit: 5000 })
    check(
      '索引坏掉 → 重建，列表照常',
      afterBroken.some((t) => t.id === a.id),
      String(afterBroken.length),
    )
    rmSync(indexFile, { force: true })
    taskIndex.reset()
    check(
      '索引文件没了 → 重建',
      taskCore.list({ limit: 5000 }).some((t) => t.id === a.id),
    )

    /* 外部直接塞一个任务文件（模拟「不是这个进程写的」）→ 数量对不上，应当能发现 */
    const outsider = newTask('外面进来的')
    taskIndex.reset()
    writeFileSync(indexFile, JSON.stringify({ version: 1, items: [] }), 'utf8')
    check(
      '★ 目录里多出来的任务不会被索引漏掉（数量对不上就重建）',
      taskCore.list({ limit: 5000 }).some((t) => t.id === outsider.id),
    )
    writeFileSync(indexFile, backup, 'utf8')
    taskIndex.reset()

    /* 外部删一个文件 → 列表里不许出现「幽灵任务」 */
    const ghost = newTask('会被外面删掉')
    taskIndex.reset()
    taskCore.list({ limit: 5 }) /* 先把索引刷成含它的状态 */
    rmSync(taskIo.fileFor(ghost.id), { force: true })
    const afterGhost = taskCore.list({ limit: 5000 })
    check(
      '★ 文件没了就不返回它（不返回 null 项）',
      afterGhost.every((t) => t && t.id !== ghost.id),
    )
    created.splice(created.indexOf(ghost.id), 1)
    taskIndex.reset()

    /* ── ③ 过滤 / 排序 / 上限 ───────────────────────────── */
    group('AG-039 / 过滤与排序')
    taskIndex.reset()
    const running = newTask('还在跑')
    const paused = newTask('停住')
    taskCore.update(paused.id, { status: 'paused' })
    check(
      '按状态过滤',
      taskCore.list({ status: 'paused', limit: 5000 }).every((t) => t.status === 'paused'),
    )
    check(
      '★ 按一组状态过滤（未完成清单用这个）',
      taskCore
        .list({ statuses: ['paused', 'running'], limit: 5000 })
        .some((t) => t.id === paused.id) &&
        taskCore.list({ statuses: ['paused'], limit: 5000 }).every((t) => t.status === 'paused'),
    )
    check(
      '按会话过滤',
      taskCore.list({ sessionId: SESSION, limit: 5000 }).every((t) => t.sessionId === SESSION),
    )
    check('别的会话查不到', taskCore.list({ sessionId: '不存在的会话' }).length === 0)
    const limited = taskCore.list({ limit: 2 })
    check('limit 生效', limited.length === 2, String(limited.length))
    check(
      '★ 按更新时间新→旧',
      limited[0].updatedAt >= limited[1].updatedAt,
      `${limited[0].updatedAt} vs ${limited[1].updatedAt}`,
    )
    check(
      '未完成清单能查到刚建的那条',
      taskCore.unfinished().some((t) => t.id === running.id),
    )

    /* ── ④ ★ 不再全表通读 ─────────────────────────────── */
    group('AG-039 / 列任务不许全表通读')
    /* 先造一批任务，让目录里明显多于要返回的条数 */
    for (let i = 0; i < 60; i += 1) newTask(`批量 ${i}`)
    taskIndex.reset()

    const realRead = fs.readFileSync
    let reads = 0
    fs.readFileSync = function counted(...args) {
      reads += 1
      return realRead.apply(this, args)
    }
    let listedSmall = []
    try {
      listedSmall = taskCore.list({ limit: 10 })
    } finally {
      fs.readFileSync = realRead
    }
    check('列 10 条就返回 10 条', listedSmall.length === 10, String(listedSmall.length))
    /*
     * 判据：读文件次数要**跟返回条数一个量级**，而不是跟目录里的总数一个量级。
     * 这里宽松些（索引 + 10 个任务 + 余量），但比「读 60 个」明显小。
     */
    check('★ 读文件次数只跟返回条数有关（不是全表通读）', reads <= 20, `读了 ${reads} 个文件`)

    /*
     * ★ 删除也要更新索引 —— 判据同样是「别触发重建」。
     *   忘了更新的话功能上照样对（「文件没了就跳过」兜着，数量校验也会重建），
     *   但**每次删除后的第一次列任务都要把整个目录读一遍**。
     *   功能正确性由上面那条兜住，这条盯的是快路径。
     */
    const doomed = newTask('等着被删的')
    taskCore.list({ limit: 5 }) /* 先把索引刷成含它的状态 */
    taskCore.remove(doomed.id)
    created.splice(created.indexOf(doomed.id), 1)
    let readsAfterRemove = 0
    fs.readFileSync = function counted(...args) {
      readsAfterRemove += 1
      return realRead.apply(this, args)
    }
    try {
      taskCore.list({ limit: 10 })
    } finally {
      fs.readFileSync = realRead
    }
    check(
      '★ 删一条之后列任务也不重建（删除也要更新索引）',
      readsAfterRemove <= 20,
      `重建了（读了 ${readsAfterRemove} 个文件）`,
    )

    const realIds = taskIo.ids
    let scandir = 0
    taskIo.ids = function counted() {
      scandir += 1
      return realIds.apply(this, arguments)
    }
    try {
      taskCore.list({ limit: 10 })
    } finally {
      taskIo.ids = realIds
    }
    check('★ 热路径连目录也不重扫（索引在内存里）', scandir === 0, `扫了 ${scandir} 次`)
  } finally {
    cleanup()
    taskIndex.reset()
  }
}
