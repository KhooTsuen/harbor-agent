/**
 * 图片查看器的「跟系统打交道」三条通道
 *
 *   image:saveAs  另存为（系统保存框）
 *   image:reveal  在文件夹里显示（只对本地文件有意义）
 *   image:copy    复制到剪贴板
 *
 * 为什么不复用 `fs:reveal`：那条通道会先 `resolveInside` 把路径锁进工作
 * 目录，而对话里的图完全可能在工作目录外面（生图可存到用户自选的目录），
 * 直接走它会被「只能访问工作目录里的内容」拦住。这里的来源校验交给
 * `core/image-load.cjs`：只认用户点名的那一个地址，不列磁盘。
 *
 * 三条都全走 `register-handlers.cjs` 的 `wrapInvokeHandlers` 兜底 ——
 * 成败 / 耗时自动进动作流水、失败自动进主日志（含错误观察哨）。
 *
 * ★ 通道名要同步进 `electron/ipc-channels.cjs`，漏了自检报 `channelsMissing`。
 */

const { dialog, clipboard, shell, nativeImage } = require('electron')
const fs = require('node:fs')
const { fileURLToPath } = require('node:url')
const { loadImage } = require('../core/image-load.cjs')
const log = require('../core/log.cjs')

const FILTERS = [
  { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'] },
  { name: '所有文件', extensions: ['*'] },
]

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function register({ ipcMain, getMainWindow }) {
  /** 另存为：读回图片 → 弹保存框 → 落盘 */
  ipcMain.handle('image:saveAs', async (_event, payload = {}) => {
    try {
      const { buffer, name } = await loadImage(payload?.src)
      const picked = await dialog.showSaveDialog(getMainWindow(), {
        title: '保存图片',
        defaultPath: name,
        filters: FILTERS,
      })
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }

      fs.writeFileSync(picked.filePath, buffer)
      log.info(`图片另存为 ${picked.filePath}`)
      return { ok: true, path: picked.filePath }
    } catch (error) {
      log.warn(`图片另存为失败：${message(error)}`)
      return { ok: false, error: message(error) }
    }
  })

  /** 在文件夹里显示 —— 网图 / 内联图没有磁盘位置，直接说清楚 */
  ipcMain.handle('image:reveal', async (_event, payload = {}) => {
    const src = String(payload?.src ?? '')
    if (!/^file:/i.test(src)) {
      return { ok: false, error: '这张图不在本地磁盘上（网图或内联图），没法定位' }
    }
    try {
      const file = fileURLToPath(src)
      if (!fs.existsSync(file)) return { ok: false, error: '找不到这个文件' }
      shell.showItemInFolder(file)
      return { ok: true, path: file }
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  })

  /** 复制到剪贴板：别的程序能直接粘贴 */
  ipcMain.handle('image:copy', async (_event, payload = {}) => {
    try {
      const { buffer } = await loadImage(payload?.src)
      const image = nativeImage.createFromBuffer(buffer)
      if (image.isEmpty()) return { ok: false, error: '这个格式没法复制到剪贴板' }
      clipboard.writeImage(image)
      return { ok: true }
    } catch (error) {
      log.warn(`图片复制失败：${message(error)}`)
      return { ok: false, error: message(error) }
    }
  })
}

module.exports = { register }
