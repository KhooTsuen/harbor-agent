/**
 * IPC：开屏的两个数据源（都只读）
 *
 *   · workspace:scan   目录是什么（名字 / 技术栈 / 测试入口）+ Git 摘要
 *                      —— 实现在 core/workspace-summary.cjs（纯函数，自检直接测）
 *   · task:testStatus  台账里「最近一次测试」的结论
 *                      —— 判据复用 core/task-outcome.cjs 的 isTestCommand，
 *                      跟「下一步」的措辞、航道畅通彩蛋同源，不另开一套
 *
 * 为什么单独一个 handler 文件：safety.cjs 贴着 300 行上限，
 * 而且这两条通道的消费方是**开屏**（另一块关注点），放一起好找。
 */

const { ipcMain } = require('electron')
const { resolveWorkdir } = require('./workdir.cjs')
const summary = require('../core/workspace-summary.cjs')
const taskCore = require('../core/task.cjs')
const outcome = require('../core/task-outcome.cjs')

ipcMain.handle('workspace:scan', (_event, dir) => summary.scanWorkspace(resolveWorkdir(dir)))

/**
 * 最近一次测试：从最近 50 条任务里找**最后一条测试命令**。
 * 只回结论（跑没跑 / 过没过 / 什么时候 / 跑的是什么），不回日志。
 */
ipcMain.handle('task:testStatus', (_event, options = {}) => {
  const workdir = String(options.workdir ?? '')
  const tasks = taskCore
    .list({ limit: 50, workdir })
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  for (const task of tasks) {
    const tests = (task.commands ?? []).filter((item) => outcome.isTestCommand(item.command))
    const last = tests[tests.length - 1]
    if (!last) continue
    return {
      ok: true,
      found: true,
      tests: last.exitOk === true ? 'passed' : last.exitOk === false ? 'failed' : 'unknown',
      command: String(last.command ?? '').slice(0, 200),
      at: Number(last.at ?? task.updatedAt ?? 0),
      taskId: String(task.id ?? ''),
    }
  }
  return { ok: true, found: false, tests: 'none' }
})
