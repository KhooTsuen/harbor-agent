/**
 * 会话 IPC
 *
 * 渲染层的侧栏、消息流都从这里取数据。
 */

const session = require('../core/session.cjs')
const { listFast } = require('../core/session-list-async.cjs')
const config = require('../core/config.cjs')
const log = require('../core/log.cjs')

function register({ ipcMain }) {
  /*
   * ★ 走**启动快路径**（2026-10-20）：开发版有个 141 MB 的会话，原来同步版
   *   要把每个会话整篇读进来逐行解析（连数条数一起），实测 10 个这样的会话
   *   要 21.9 秒，期间事件循环被占死 → 界面「点了没反应」。
   *   现在只读首行 + 后台补条数，列表秒出，结果形状与 `session.list()` 相同。
   */
  ipcMain.handle('session:list', () => listFast())
  ipcMain.handle('session:search', (_event, query, limit) =>
    session.search(query, Number(limit) || 50),
  )

  /** 用过的所有对话文件夹（侧栏切换用） */
  ipcMain.handle('session:workdirs', () => session.workdirs())

  ipcMain.handle('session:create', (_event, options) => {
    /*
     * 每条会话自己记一个 workdir —— 侧栏按它分组（「对话文件夹」），
     * 也是这个会话自己的文件访问范围。
     *
     * `undefined` = 没指定，用当前全局工作目录；
     * `''`        = **明确表示不属于任何文件夹**（单独对话）。
     * 这两个必须区分开，否则「单独对话」会被硬塞进某个文件夹。
     */
    const requested = options?.workdir
    const workdir = typeof requested === 'string' ? requested : config.get().general.workdir || ''
    return session.create({ ...(options ?? {}), workdir })
  })

  ipcMain.handle('session:load', (_event, id) => session.load(String(id)))

  ipcMain.handle('session:append', (_event, id, message) =>
    session.append(String(id), message ?? {}),
  )

  ipcMain.handle('session:updateMeta', (_event, id, patch) =>
    session.updateMeta(String(id), patch ?? {}),
  )

  ipcMain.handle('session:remove', (_event, id) => {
    session.remove(String(id))
    log.info(`删除会话 ${id}`)
    return { ok: true }
  })

  ipcMain.handle('session:removeAll', () => {
    const result = session.removeAll()
    log.info(`清空会话（${result.count} 个）`)
    return result
  })

  /** 记一个压缩点 */
  ipcMain.handle('session:appendCompact', (_event, id, summary, upTo) =>
    session.appendCompact(String(id), summary, Number(upTo) || 0),
  )

  /** 批量导入线程，返回带新 id 的数组 */
  ipcMain.handle('session:import', (_event, threadList) =>
    session.importThreads(Array.isArray(threadList) ? threadList : []),
  )

  /** 把会话转成模型 messages（只取最近 N 条） */
  ipcMain.handle('session:toApiMessages', (_event, id, limit) =>
    session.toApiMessages(String(id), Number(limit) || 20),
  )
}

module.exports = { register }
