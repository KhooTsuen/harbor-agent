/**
 * 「回退到指定检查点」的 IPC（`changeset:rollbackTo`）
 *
 * 为什么单独一个文件而不是塞进 `handlers/safety.cjs`：那边已经 299 行，
 * 贴着硬约束 #2 的 300 行上限，再挤一个 handler 进去就只能删别人的注释了。
 * 语义、边界（检查点之前的改动不动 / 跨检查点的事务 / 部分文件恢复失败）
 * 全在 `electron/core/changeset-rollback.cjs` 的文件头里写着。
 *
 * 这里只做三件事：**校验参数 → 调内核 → 记一行日志**。
 */

const changeset = require('../core/changeset.cjs')
const log = require('../core/log.cjs')

function register({ ipcMain }) {
  ipcMain.handle('changeset:rollbackTo', (_event, payload = {}) => {
    const taskId = String(payload?.taskId ?? '')
    const result = changeset.rollbackTo(taskId, payload?.checkpointId)
    if (result.ok) {
      log.info(
        `用户回退到检查点：任务 ${taskId}，撤了 ${result.changesets.length} 个事务` +
          `（恢复 ${result.restored.length} 个文件），${result.skipped.length} 个文件因改动更早而留着`,
      )
    }
    return result
  })
}

module.exports = { register }
