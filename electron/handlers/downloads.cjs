/**
 * 下载管理器 IPC
 *
 * 八条通道。**所有写入都过 `core/download-queue.cjs`** —— 校验（地址协议、
 * 落盘路径）与调度都在那一层，这里只做「解析参数 + 转发 + 推事件」。
 *
 * ★ 通道名要同步进 `electron/ipc-channels.cjs`（那份写死的清单是自检点名用的，
 *   漏了会报 `channelsMissing`）。
 *
 * ── 两条这里必须把住的 ──
 *
 * ① **地址只认 http/https**。`file://` / `javascript:` 这类从渲染层递进来
 *    一律拒 —— 这是下载器的第一道门，不是靠界面自觉。
 * ② **路径解析不赌**：相对路径按当前工作目录展开，绝对路径原样用。落盘位置
 *    是用户自己选的，不走 `capability.check`（那是给模型工具调用的授权门）。
 *
 * 进度不在这里攒：`queue` 通过注入的 `send` 往渲染层推 `downloads:event`，
 * 界面收到 `progress` 就地更新、收到状态跃迁再拉一次列表。
 */

const path = require('node:path')
const queue = require('../core/download-queue.cjs')
const { DIRS } = require('../core/paths.cjs')
const log = require('../core/log.cjs')

/** 只放行这两个协议（其余一律拒，和 `url-policy.cjs` 的外抛白名单同源） */
function isHttpUrl(raw) {
  try {
    const protocol = new URL(String(raw)).protocol.toLowerCase()
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** 相对路径按工作目录展开；绝对路径原样（用户在界面里自己选的位置） */
function resolveTarget(input, workdir) {
  const raw = String(input ?? '').trim()
  if (!raw) return ''
  if (path.isAbsolute(raw)) return path.normalize(raw)
  return path.resolve(workdir || DIRS.workspace, raw)
}

function register({ ipcMain, send, getWorkdir }) {
  /* 事件出口：主进程把它推给渲染层（见 preload 的 onDownloadsEvent） */
  queue.attach({ emit: (event) => send('downloads:event', event) })

  ipcMain.handle('downloads:list', () => ({ ok: true, ...queue.snapshot() }))

  ipcMain.handle('downloads:add', (_event, input = {}) => {
    const url = String(input.url ?? '').trim()
    if (!isHttpUrl(url)) return { ok: false, error: '地址必须是 http/https' }
    const workdir = typeof getWorkdir === 'function' ? getWorkdir() : ''
    const file = resolveTarget(input.path, workdir)
    if (!file) return { ok: false, error: '保存路径不能为空' }
    const result = queue.add({ url, file })
    if (!result.ok) log.warn(`加入下载失败（${input.path}）：${result.error}`)
    return result
  })

  ipcMain.handle('downloads:pause', (_event, id) => queue.pause(String(id)))
  ipcMain.handle('downloads:resume', (_event, id) => queue.resume(String(id)))
  ipcMain.handle('downloads:retry', (_event, id) => queue.retry(String(id)))
  ipcMain.handle('downloads:remove', (_event, id) => queue.remove(String(id)))
  ipcMain.handle('downloads:clear', () => queue.clearFinished())
  ipcMain.handle('downloads:setLimits', (_event, patch = {}) => queue.setLimits(patch))
}

module.exports = { register }
