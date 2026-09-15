/**
 * 技能 IPC
 */

const { shell } = require('electron')
const skills = require('../core/skills.cjs')
const log = require('../core/log.cjs')

function register({ ipcMain }) {
  ipcMain.handle('skills:list', () => skills.list())

  ipcMain.handle('skills:create', (_event, name, description) => skills.create(name, description))

  ipcMain.handle('skills:remove', (_event, id) => skills.remove(id))

  /** 用系统文件管理器打开技能目录（方便用户自己写） */
  ipcMain.handle('skills:openDir', async () => {
    const dir = skills.ensureDir()
    await shell.openPath(dir)
    log.info(`打开技能目录 ${dir}`)
    return { ok: true, dir }
  })
}

module.exports = { register }
