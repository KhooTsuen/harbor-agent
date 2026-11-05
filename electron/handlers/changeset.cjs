/**
 * 改动事务的 IPC：列表 / 详情 / 整批撤销（`changeset:list` / `:get` / `:rollback`）
 *
 * 为什么单独一个文件：`handlers/safety.cjs` 已经贴着 300 行上限，再往里加就把
 * 「冲突拦截」这段挤没了。语义全在内核：
 *   · 撤销的安全边界（什么算覆盖冲突、为什么 open 事务不比 mtime）
 *     → `electron/core/changeset-conflict.cjs` 的文件头
 *   · 「撤到某个检查点」→ `changeset-rollback.cjs`（本目录那一个）
 *
 * 这里只做三件事：**校验参数 → 调内核 → 记一行日志**。
 */

const changeset = require('../core/changeset.cjs')
const log = require('../core/log.cjs')

function register({ ipcMain }) {
  ipcMain.handle('changeset:list', (_event, options = {}) => ({
    ok: true,
    changesets: changeset.list({
      limit: Math.min(100, Number(options.limit) || 20),
      taskId: options.taskId ?? '',
      sessionId: options.sessionId ?? '',
    }),
  }))

  ipcMain.handle('changeset:get', (_event, id) => ({
    ok: true,
    changeset: changeset.get(String(id ?? '')),
  }))

  /*
   * 撤销一次改动。`force: true` = 用户已经在确认卡上看过冲突清单、仍然要覆盖。
   *
   * ★ 入参兼容两种形状：老调用方传 `id` 字符串照旧能用（`force` 缺省 = 不覆盖）。
   *   通道名与清单没变（`electron/ipc-channels.cjs` 的 EXPECTED_CHANNELS 不用动）。
   * ★ `blocked: true` 时**盘上一个字节都没动**、事务状态也没改 ——
   *   界面据此弹「要不要覆盖」，用户取消之后这条事务仍然撤得动。
   */
  ipcMain.handle('changeset:rollback', (_event, raw) => {
    const payload = typeof raw === 'string' ? { id: raw } : (raw ?? {})
    const id = String(payload.id ?? '')
    const result = changeset.rollback(id, { force: payload.force === true })
    if (result.blocked) {
      log.info(`撤销被拦下：${id}（${result.conflicts?.length ?? 0} 个文件有新改动，等用户确认）`)
      return result
    }
    log.info(`用户回滚了一次改动：${id}（恢复 ${result.restored?.length ?? 0} 个文件）`)
    return result
  })
}

module.exports = { register }
