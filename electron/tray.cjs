/**
 * 托盘与「显示/退出」
 *
 * 从 main.cjs 拆出来的（那边过 300 行了）。
 *
 * 关窗口不退出进程（窗口只是 hide），真正的退出走托盘菜单或 app:quit ——
 * 这是桌面 Agent 的常态：它是常驻的，不是「关掉就没了」的小工具。
 */

const path = require('node:path')
const fs = require('node:fs')
const { app, Tray, Menu } = require('electron')
const log = require('./core/log.cjs')
const windowState = require('./window-state.cjs')

let tray = null
/** true 表示「真的要退出了」，区别于「只是关窗口」 */
let quitting = false
/** 窗口被关掉之后要让 main.cjs 重新建一个 —— 回调注入，避免反向依赖 */
let createWindowHook = () => {}

function showWindow() {
  const win = windowState.get()
  if (!win) {
    createWindowHook()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function setupTray({ onCreateWindow } = {}) {
  if (onCreateWindow) createWindowHook = onCreateWindow
  if (tray) return

  /* 图标：打包后在 resources 里，开发时在 build/ 下 */
  const candidates = [
    path.join(__dirname, '..', 'build', 'icon-128.png'),
    path.join(process.resourcesPath ?? '', 'build', 'icon-128.png'),
  ]
  const icon = candidates.find((file) => fs.existsSync(file))
  if (!icon) {
    log.warn('找不到托盘图标，托盘不创建')
    return
  }

  try {
    tray = new Tray(icon)
    tray.setToolTip('Personal Agent')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示窗口', click: () => showWindow() },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            quitting = true
            app.quit()
          },
        },
      ]),
    )
    tray.on('click', () => showWindow())
    log.info('托盘已就绪')
  } catch (error) {
    log.warn(`托盘创建失败：${error instanceof Error ? error.message : error}`)
  }
}

module.exports = {
  setupTray,
  showWindow,
  isQuitting: () => quitting,
  setQuitting: (v) => {
    quitting = v
  },
}
