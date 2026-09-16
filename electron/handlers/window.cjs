/**
 * 窗口外观 + 窗口相关 IPC
 *
 * 从 main.cjs 拆出来的（那边贴着 300 行红线）。
 *
 * ① **标题栏**：用 titleBarStyle:'hidden' 把系统那条标题栏的**背景**隐藏，
 *    界面自己顶到窗口最上沿；最小化/最大化/关闭仍用 **Windows 原生按钮**，
 *    由 titleBarOverlay 浮在右上角。这样能保住原生交互（悬停分屏 Snap
 *    Layout、双击最大化、系统菜单），不用自己模拟，顶栏也就真正成了软件
 *    的一部分，而不是外面再套一层系统边框。
 *
 *    高度必须等于窗口级顶栏（AppTitleBar）的高度，按钮才和那条对齐。
 *    macOS 不支持 overlay，那边用 hiddenInset（保留红绿灯）。
 *
 * ② **默认全屏窗口化**：启动就铺满屏幕。是「最大化」不是独占全屏 ——
 *    任务栏还在、也能拖回来。自检/截图模式不最大化，否则截图尺寸不可预期。
 *
 * 窗口按钮画在内容上之后，颜色得跟着主题走（有四套主题，含一套亮色），
 * 所以渲染层会在主题变化时通过 `window:titleBar` 把当前色值推过来 ——
 * overlay 只吃纯色，CSS 变量传不进去。
 */

/* 和 AppTitleBar 的高度一致 */
const TITLEBAR_HEIGHT = 40

const DEFAULT_COLORS = { color: '#101010', symbolColor: '#f8f8f8' }

function windowChromeOptions() {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset' }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...DEFAULT_COLORS, height: TITLEBAR_HEIGHT },
  }
}

/** 显示窗口；非自检模式下铺满屏幕 */
function showAndMaximize(win, headless) {
  if (headless) return
  win.maximize()
  win.show()
}

function register({ ipcMain, app, setQuitting, showWindow, getMainWindow }) {
  ipcMain.handle('app:quit', () => {
    setQuitting(true)
    app.quit()
  })

  ipcMain.handle('app:showWindow', () => {
    showWindow()
    return { ok: true }
  })

  ipcMain.handle('window:titleBar', (_event, colors) => {
    const win = getMainWindow()
    if (!win || process.platform === 'darwin') return { ok: false }
    try {
      win.setTitleBarOverlay({
        color: colors?.color ?? DEFAULT_COLORS.color,
        symbolColor: colors?.symbolColor ?? DEFAULT_COLORS.symbolColor,
        height: TITLEBAR_HEIGHT,
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })
}

module.exports = { register, windowChromeOptions, showAndMaximize }
