/**
 * 项目 IPC
 *
 * 五条通道。所有写入都过 `core/projects.cjs` —— 校验（名字长度、字段白名单）
 * 都在那一层，这里不重复判。
 *
 * ★ 通道名要同步进 `electron/ipc-channels.cjs`（那份写死的清单是自检点名用的）。
 *
 * ── 这里最要紧的一条 ──
 *
 * `projects:remove` **只删登记项，不删会话和任务**。那些是用户的东西 ——
 * 界面上必须把这句话说出来（「移除项目」而不是「删除项目及其对话」）。
 * 归属它的会话之后会落到「未归类」，而那个目录一旦又有新会话，
 * `ensureFor` 会把登记项重新建出来（沿用老行为：目录在，项目就在）。
 */

const projects = require('../core/projects.cjs')
const log = require('../core/log.cjs')

function register({ ipcMain }) {
  /**
   * 列项目 + 当前选中 + 各自有多少会话 / 任务（界面上的角标要用）。
   *
   * 每次读都先跑一遍 `ensureMigrated()`：新开了新目录的会话之后，
   * 项目列表能自己长出来，不需要用户手动「刷新」。
   * 它是幂等的，跑第二遍 `created` 是 0。
   */
  ipcMain.handle('projects:list', () => {
    try {
      projects.ensureMigrated()
    } catch (error) {
      log.warn(`项目登记补全失败（列表照常返回）：${error instanceof Error ? error.message : error}`)
    }

    const counts = { sessions: {}, tasks: {} }
    try {
      for (const item of require('../core/session.cjs').list()) {
        const key = item.projectId || ''
        counts.sessions[key] = (counts.sessions[key] ?? 0) + 1
      }
    } catch {
      /* 会话读不出来只影响角标 */
    }
    try {
      for (const item of require('../core/task-index.cjs').list()) {
        const key = item.projectId || ''
        counts.tasks[key] = (counts.tasks[key] ?? 0) + 1
      }
    } catch {
      /* 任务索引读不出来只影响角标 */
    }

    return { ok: true, items: projects.list(), activeId: projects.activeId(), counts }
  })

  ipcMain.handle('projects:save', (_event, input = {}) => {
    /* 带 id = 改，不带 = 新建（和 schedule-store 同一个约定） */
    const result = input?.id ? projects.update(input.id, input) : projects.create(input)
    if (result.ok) {
      const action = input?.id ? '更新' : '新建'
      log.info(`项目${action}：${result.item.name}`)
    }
    return result
  })

  ipcMain.handle('projects:remove', (_event, id) => projects.remove(id))

  ipcMain.handle('projects:setActive', (_event, id) => projects.setActive(id))
}

module.exports = { register }
