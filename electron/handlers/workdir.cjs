/**
 * IPC：工作目录
 *
 * 从 main.cjs 拆出来的（那边过 300 行了）。
 *
 * 三种「选目录」是不同的意思，别混：
 *   · workdir:pick   换**默认**工作目录（全局设置）
 *   · workdir:choose 只给**这一条对话**挂一个目录，不动全局
 *   · workdir:get    当前默认目录
 *
 * resolveWorkdir 处理「会话自己声明的目录已经不在了」的情况
 * （换机器、拔 U 盘都会）—— 回落到默认目录，而不是让 Agent 在一个
 * 不存在的地方读写然后报一堆难懂的错。
 */

const fs = require('node:fs')
const { ipcMain, dialog } = require('electron')
const { DIRS } = require('../core/paths.cjs')
const config = require('../core/config.cjs')
const log = require('../core/log.cjs')
const windowState = require('../window-state.cjs')

/* ── 工作目录 ───────────────────────────────────────────── */

function currentWorkdir() {
  const configured = config.get().general.workdir
  return configured && fs.existsSync(configured) ? configured : DIRS.workspace
}

/**
 * 把「会话自己声明的目录」解析成一个真实可用的目录。
 *
 * 目录可能已经被删了 / 被移走了（换机器、拔 U 盘都算），
 * 这时候不能直接用它 —— 回落到默认工作目录，
 * 否则 Agent 会在一个不存在的地方读写，报的错还很难懂。
 */
function resolveWorkdir(requested) {
  if (typeof requested === 'string' && requested && fs.existsSync(requested)) return requested
  return currentWorkdir()
}

ipcMain.handle('workdir:get', () => currentWorkdir())

/**
 * 只弹目录选择框、**不改全局工作目录**。
 *
 * 和 workdir:pick 的区别：那个是「换我以后默认用哪个目录」，
 * 这个是「这条对话挂在哪个目录」—— 给单条对话挂目录不该顺手改全局设置。
 */
ipcMain.handle('workdir:choose', async () => {
  const picked = await dialog.showOpenDialog(windowState.get(), {
    title: '选择这个对话的工作目录',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
  return { ok: true, dir: picked.filePaths[0] }
})

ipcMain.handle('workdir:pick', async () => {
  const picked = await dialog.showOpenDialog(windowState.get(), {
    title: '选择工作目录',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
  const dir = picked.filePaths[0]
  config.patch({ general: { workdir: dir } })
  log.info(`工作目录切到 ${dir}`)
  return { ok: true, workdir: dir }
})

module.exports = { currentWorkdir, resolveWorkdir }
