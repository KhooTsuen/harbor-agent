/**
 * 导出 IPC
 *
 * 把线程 / 数据导出成文件。用系统保存对话框让用户选位置。
 */

const { dialog } = require('electron')
const fs = require('node:fs')
const log = require('../core/log.cjs')

function register({ ipcMain, getMainWindow }) {
  /**
   * 弹保存对话框，写一段文本到用户选的位置。
   * payload: { defaultName, content, filters }
   */
  ipcMain.handle('export:saveText', async (_event, payload) => {
    const win = getMainWindow()
    const defaultName = typeof payload?.defaultName === 'string' ? payload.defaultName : 'export.md'
    const content = typeof payload?.content === 'string' ? payload.content : ''

    const picked = await dialog.showSaveDialog(win, {
      title: '导出到…',
      defaultPath: defaultName,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'JSON', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })

    if (picked.canceled || !picked.filePath) {
      return { ok: false, canceled: true }
    }

    try {
      fs.writeFileSync(picked.filePath, content, 'utf8')
      log.info(`导出到 ${picked.filePath}`)
      return { ok: true, path: picked.filePath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /** 弹文件选择框，读一个 JSON 回来（用于导入） */
  ipcMain.handle('import:pickJson', async () => {
    const win = getMainWindow()
    const picked = await dialog.showOpenDialog(win, {
      title: '选择要导入的 JSON 文件',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })

    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }

    const file = picked.filePaths[0]
    try {
      const stat = fs.statSync(file)
      /* 导入文件不该太大；超过 32MB 多半选错了 */
      if (stat.size > 32 * 1024 * 1024) {
        return {
          ok: false,
          error: `文件太大（${Math.round(stat.size / 1024 / 1024)} MB），上限 32 MB`,
        }
      }
      const content = fs.readFileSync(file, 'utf8')
      log.info(`导入：读入 ${file}`)
      return { ok: true, content, path: file }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

module.exports = { register }
