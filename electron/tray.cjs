/**
 * 托盘与「显示/退出」
 *
 * 从 main.cjs 拆出来的（那边过 300 行了）。
 *
 * 关窗口不退出进程（窗口只是 hide），真正的退出走托盘菜单或 app:quit ——
 * 这是桌面 Agent 的常态：它是常驻的，不是「关掉就没了」的小工具。
 *
 * ── 一处真机踩坑（AG-029 之后）──
 * 用户报「点 × 就退出了」「右下角图标右键没菜单」。查下来是**同一个问题**：
 * 点 × 其实好好地藏到了托盘（用 WM_CLOSE 复现验证过），但**右键弹不出菜单**
 * 就再也叫不回来，看着就像退出。所以这里：
 *   ① 右键**显式**弹菜单（不再只靠 setContextMenu）—— 顺带能记日志、能排查；
 *   ② 第一次藏到托盘时用系统通知告诉用户「还在这儿、怎么回来」。
 *     （这正是「以为退出了」的根源：Windows 11 会把新图标塞进折叠区，
 *       用户根本不知道它还在。）
 */

const path = require('node:path')
const fs = require('node:fs')
const { app, Tray, Menu } = require('electron')
const log = require('./core/log.cjs')
const windowState = require('./window-state.cjs')
const { BRAND } = require('./core/config-defaults.cjs')

let tray = null
/** 菜单要留引用：右键时显式弹它（不再只靠 setContextMenu） */
let trayMenu = null
/** true 表示「真的要退出了」，区别于「只是关窗口」 */
let quitting = false
/** 窗口被关掉之后要让 main.cjs 重新建一个 —— 回调注入，避免反向依赖 */
let createWindowHook = () => {}
/** 藏到托盘时的提示（主进程的 Notification，注册清单注入） */
let notifyHidden = null
let hiddenHintShown = false

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

/**
 * 藏到托盘（点 × 走这里）。
 *
 * 第一次会补一条系统通知 —— 否则用户点完 × 就不见了，还以为程序退出了。
 * 只提示一次：第二次他已经知道了，再弹就是骚扰。
 */
function hideToTray(win) {
  win.hide()
  if (hiddenHintShown) return
  hiddenHintShown = true
  try {
    notifyHidden?.({
      id: '',
      title: `${BRAND.name} 还在后台跑`,
      body: '点右下角托盘图标可以回来；要真正退出，用托盘图标的右键菜单。',
    })
  } catch (error) {
    log.warn(`托盘提示发不出去：${error instanceof Error ? error.message : error}`)
  }
}

function trayIconPath() {
  /*
   * 三种布局都要能找着：
   *   ① 开发（electron/ 的上一层有 build/）
   *   ② 打包 —— 我们自己的 build-portable 把 build/ 放进 **resources/app/**
   *   ③ 打包 —— 有些打包器会把它放在 resources/ 根下
   *
   * ★ ② 曾经漏过：打包脚本拷到 resources/app/build/，这里只找 resources/build/，
   *   于是**打包版的托盘图标一直是坏的**（干净环境跑测试时才暴露出来）。
   */
  const candidates = [
    path.join(__dirname, '..', 'build', 'icon-128.png'),
    path.join(process.resourcesPath ?? '', 'app', 'build', 'icon-128.png'),
    path.join(process.resourcesPath ?? '', 'build', 'icon-128.png'),
    /* 同一份东西在资源树里也可能叫 icon.png */
    path.join(process.resourcesPath ?? '', 'app', 'build', 'icon.png'),
    /* 实测打包产物里 resources/ 根下也直接放了一份 */
    path.join(process.resourcesPath ?? '', 'icon-128.png'),
  ]
  return candidates.find((file) => file && fs.existsSync(file))
}

function setupTray({ onCreateWindow, notify } = {}) {
  if (onCreateWindow) createWindowHook = onCreateWindow
  if (notify) notifyHidden = notify
  if (tray) return

  const icon = trayIconPath()
  if (!icon) {
    log.warn('找不到托盘图标，托盘不创建')
    return
  }

  try {
    tray = new Tray(icon)
    tray.setToolTip(BRAND.name)
    trayMenu = Menu.buildFromTemplate([
      { label: '显示窗口', click: () => showWindow() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ])

    /*
     * 右键菜单：**显式弹**。
     *
     * 原来只写了 `tray.setContextMenu(menu)`（Windows 上由 Electron 自己弹），
     * 真机上用户报「右键没菜单」。改成自己处理右键有个额外好处：
     * 能记日志、出问题查得到。
     * macOS 另说：那边左键就是菜单，仍用 setContextMenu 的默认行为。
     */
    if (process.platform === 'darwin') {
      tray.setContextMenu(trayMenu)
    } else {
      tray.on('right-click', () => {
        log.info('托盘：右键 → 弹出菜单')
        tray?.popUpContextMenu(trayMenu)
      })
    }

    tray.on('click', () => showWindow())
    tray.on('double-click', () => showWindow())
    log.info('托盘已就绪')
  } catch (error) {
    log.warn(`托盘创建失败：${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 销毁托盘图标。
 *
 * 用户报过：**退出后托盘图标不消失**（鼠标划过去才没）。
 * Electron 退出时一般会自己清理，但只要退出路径稍有不同（直接 app.exit()、
 * 进程被杀、或者 Windows 那边没收到托盘重生通知），图标就会挂在那儿。
 * 显式 destroy 是官方推荐的做法 —— 别把这事托付给"它应该会自动清理"。
 */
function destroyTray() {
  if (!tray) return
  try {
    tray.destroy()
    log.info('托盘图标已销毁')
  } catch (error) {
    log.warn(`销毁托盘图标失败：${error instanceof Error ? error.message : error}`)
  } finally {
    tray = null
    trayMenu = null
  }
}

module.exports = {
  setupTray,
  destroyTray,
  showWindow,
  hideToTray,
  isQuitting: () => quitting,
  setQuitting: (v) => {
    quitting = v
  },
}
