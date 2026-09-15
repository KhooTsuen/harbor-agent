/**
 * 诊断包 IPC
 *
 * 两种用法：
 *   · 复制到剪贴板 —— 用户直接粘给开发者，最省事
 *   · 存成文件     —— 内容长的时候方便翻
 */

const { clipboard, dialog } = require('electron')
const diagnostics = require('../core/diagnostics.cjs')
const log = require('../core/log.cjs')

function register({ ipcMain }) {
  /** 生成并放进剪贴板 */
  ipcMain.handle('diagnostics:copy', () => {
    try {
      const result = diagnostics.build()
      clipboard.writeText(result.text)
      return {
        ok: true,
        chars: result.text.length,
        errorCount: result.errorCount,
        logLines: result.logLines,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(`生成诊断包失败：${message}`)
      return { ok: false, error: message }
    }
  })

  /** 生成并存成文件，返回路径 */
  ipcMain.handle('diagnostics:save', async (event) => {
    try {
      const result = diagnostics.build()
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '保存诊断包',
        defaultPath: `personal-agent-diagnostics.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (canceled || !filePath) return { ok: false, canceled: true }

      require('node:fs').writeFileSync(filePath, result.text, 'utf8')
      void event
      return { ok: true, path: filePath, chars: result.text.length }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /** 打开数据目录（诊断文件也在这里） */
  ipcMain.handle('diagnostics:openDir', async () => {
    const { shell } = require('electron')
    const { DIRS } = require('../core/paths.cjs')
    await shell.openPath(DIRS.data)
    return { ok: true }
  })
}

module.exports = { register }
