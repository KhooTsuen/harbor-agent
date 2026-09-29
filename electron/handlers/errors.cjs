/**
 * 「错误」标签的 IPC
 *
 * 一个通道：`errors:list` —— 把内核记的错误读出来给界面看（右栏「错误」标签）。
 *
 * **只读**：这个文件里没有任何写文件/删文件的地方（清理过期记录是观察哨启动时做的，
 * 见 `core/error-retention.cjs`）。界面只看，不动数据 —— 和命令行那把工具同一条铁律。
 *
 * 数据量很小（一天几行），不需要分页；真多了由读取器的 `limit` 兜住。
 */

const reader = require('../core/error-reader.cjs')
const log = require('../core/log.cjs')

function register({ ipcMain }) {
  ipcMain.handle('errors:list', (_event, options = {}) => {
    try {
      const result = reader.read(options ?? {})
      /* 动作流水里能看出来「用户翻过错误清单」——排查时有用 */
      if (!result.entries.length && result.stats.filesTotal > 0) {
        log.warn(`错误清单为空（窗口 ${result.stats.days} 天，读了 ${result.stats.files} 个文件）`)
      }
      return result
    } catch (error) {
      /* 读不出来不是「没有错误」，得说清楚，别让界面显示成「一切正常」 */
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`读错误清单失败：${message}`)
      return { ok: false, entries: [], reason: message, stats: {} }
    }
  })
}

module.exports = { register }
