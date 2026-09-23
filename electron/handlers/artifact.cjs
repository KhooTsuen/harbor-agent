/**
 * 成果（Artifact）IPC
 *
 * 五条通道，全走 `register-handlers.cjs` 的 `wrapInvokeHandlers` 兜底 ——
 * 成败/耗时自动进动作流水、失败自动进主日志，这里不用额外埋点。
 *
 * ★ 通道名要同步进 `electron/ipc-channels.cjs`（那份写死的清单是自检点名用的，
 *   漏了会报 `channelsMissing`）—— 本批次按分工留给集成方统一加。
 *
 * 与 `changeset.cjs` 的分工见 `core/artifact.cjs` 的注释：这里只管
 * 「存 + 看 + 取回」，**不做** diff / 回滚（回滚磁盘文件是 changeset 的事）。
 */

const { shell } = require('electron')
const artifacts = require('../core/artifact.cjs')
const log = require('../core/log.cjs')

function register({ ipcMain }) {
  /**
   * 列成果（新的在前）。只给元信息 + 版本清单，**不含正文**。
   * 一份报告可能几十 KB，列清单不该把所有历史正文都拉回渲染层。
   */
  ipcMain.handle('artifact:list', (_event, options = {}) => ({
    ok: true,
    artifacts: artifacts.list({
      taskId: String(options?.taskId ?? ''),
      sessionId: String(options?.sessionId ?? ''),
      limit: options?.limit,
    }),
  }))

  /** 取正文：不传版本 = 最新版；越界版本号返回 `{ ok: false, error }`（不抛） */
  ipcMain.handle('artifact:get', (_event, id, version) => artifacts.get(id, version))

  /** 从回答里「存为成果」。同名多次 save = 同一个成果的新版本 */
  ipcMain.handle('artifact:save', (_event, draft = {}) => artifacts.save(draft))

  ipcMain.handle('artifact:remove', (_event, id) => {
    const result = artifacts.remove(id)
    if (result.ok) log.info(`删除成果 ${id}`)
    return result
  })

  /** 用系统文件管理器打开这个成果的目录（正文都在那儿，人能直接看） */
  ipcMain.handle('artifact:reveal', async (_event, id) => {
    const dir = artifacts.dirFor(id)
    if (!dir) return { ok: false, error: '成果 id 不合法' }
    await shell.openPath(dir)
    log.info(`打开成果目录 ${dir}`)
    return { ok: true, dir }
  })
}

module.exports = { register }
