/**
 * 主进程
 *
 * 职责：
 *   ① **在 app ready 之前**把所有 Electron 的路径锁到 data/ 下（绝不写 C 盘）
 *   ② 建窗口、装配 IPC；不写具体业务（业务在 core/ 和 handlers/ 里）
 */

const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, Tray, Menu } = require('electron')

const { DIRS, ensureDirs, auditNonC, markPackaged } = require('./core/paths.cjs')
const log = require('./core/log.cjs')
const config = require('./core/config.cjs')
const bootCleanup = require('./boot-cleanup.cjs')
const { installCrashGuard } = require('./crash-guard.cjs')
const { runSelfTest, runScreenshot } = require('./selftest-report.cjs')
const { currentWorkdir, resolveWorkdir } = require('./handlers/workdir.cjs')
const {
  setupTray,
  destroyTray,
  showWindow,
  hideToTray,
  setQuitting,
  isQuitting,
} = require('./tray.cjs')
const windowState = require('./window-state.cjs')
const windowChrome = require('./handlers/window.cjs')

/* ★ 兜底要最早装：装晚了就抓不到启动阶段的异常 */
installCrashGuard()
const { registerHandlers } = require('./register-handlers.cjs')
let trayNotifier = null
const navigationPolicy = require('./navigation-policy.cjs')
const pluginWatcher = require('./core/plugin-watcher.cjs')
const imageHandler = require('./handlers/image.cjs')

/* ══════════════════════════════════════════════════════════
   ① 锁路径 —— 必须早于 app.whenReady()
   ══════════════════════════════════════════════════════════ */

if (app.isPackaged) {
  markPackaged(path.dirname(process.execPath))
}

ensureDirs()

/* Chromium 自己的缓存也塞进 data/，否则会跑去 C:\Users\...\AppData */
app.setPath('userData', path.join(DIRS.data, 'chromium'))
app.setPath('sessionData', path.join(DIRS.data, 'chromium'))
app.setPath('logs', DIRS.logs)
app.setPath('crashDumps', DIRS.crash)

/* 禁掉磁盘缓存之外的花销，顺便避免它往 C 盘写 GPU 着色器缓存 */
app.commandLine.appendSwitch('disk-cache-dir', path.join(DIRS.data, 'chromium', 'cache'))
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

/* ══════════════════════════════════════════════════════════
   ② 窗口
   ══════════════════════════════════════════════════════════ */

const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? ''
/** --self-test：无窗口启动，跑完自检打印结果然后退出（CI / 我验收用） */
const SELF_TEST = process.argv.includes('--self-test')
/** --screenshot：无窗口启动，截一张图存到 data/ 然后退出 */

const SCREENSHOT = process.argv.includes('--screenshot')
/** 两个特殊模式都要跳过单实例锁，否则会被正在看的那个窗口拦住 */
const HEADLESS = SELF_TEST || SCREENSHOT
let mainWindow = null
const streams = new Map()

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#101010',
    /* 等页面画好再显示，避免白屏一闪；自检时不显示 */
    show: false,
    autoHideMenuBar: true,
    title: config.BRAND.name,
    /* 系统标题栏的背景隐藏、界面顶到窗口最上沿（见 handlers/window.cjs） */
    ...windowChrome.windowChromeOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: true,
    },
  })

  windowState.set(win)
  mainWindow = win

  win.once('ready-to-show', () => windowChrome.showAndMaximize(win, HEADLESS))

  /* 外链一律用系统浏览器打开，不在应用里跳走 */
  /* 导航策略 + webview 加固：主窗口和每个 webview 都要挂，见 navigation-policy.cjs */
  navigationPolicy.install({
    app,
    win,
    getMode: () => config.get().general.browserNavigation ?? 'ask',
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (DEV_URL) {
    void win.loadURL(DEV_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  /*
   * 关窗口 ≠ 退出。
   *
   * 本地 agent 经常在跑长任务，点个 × 就把进程杀了太粗暴 ——
   * 默认藏到托盘，任务继续跑，点托盘图标就回来。
   * 自检 / 截图模式例外（那两种模式要能正常退出）。
   */
  win.on('close', (event) => {
    if (HEADLESS || isQuitting()) return
    if (config.get().general.minimizeToTray === false) return
    event.preventDefault()
    /* 藏到托盘（第一次会补一条系统通知告诉用户「还在这儿」）—— 见 tray.cjs */
    hideToTray(win)
  })

  win.on('closed', () => {
    windowState.set(null)
    mainWindow = null
  })

  if (SELF_TEST) {
    win.webContents.once('did-finish-load', () => {
      void runSelfTest(win)
    })
  }

  if (SCREENSHOT) {
    log.info('截图模式已启用，等页面加载完')
    win.webContents.once('did-finish-load', () => {
      log.info('页面加载完成，开始截图')
      void runScreenshot(win)
    })
  }
}

/* ── 非自检时的窗口 ──────────────────────────────────────── */

/* ══════════════════════════════════════════════════════════
   ③ IPC
   ══════════════════════════════════════════════════════════ */

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

/* ── 自检：给截图/单测用 ─────────────────────────────────── */

ipcMain.handle('app:selfTest', () => {
  const audits = auditNonC()
  return {
    ok: audits.every((a) => a.ok),
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    dataDir: DIRS.data,
    workdir: currentWorkdir(),
    audits,
    config: config.forRenderer(),
  }
})

/* ── 配置 ───────────────────────────────────────────────── */

ipcMain.handle('config:get', () => config.forRenderer())

ipcMain.handle('config:patch', (_event, partial) => {
  /* 界面传来的 apiKey 先搬进凭证库，落进配置的只有 credentialRef */
  const incoming = require('./core/config-secrets.cjs').absorb(partial)
  config.patch(incoming)
  log.info('配置已更新')
  return { ok: true, config: config.forRenderer() }
})

ipcMain.handle('config:reset', () => {
  config.reset()
  return { ok: true, config: config.forRenderer() }
})

/* ══════════════════════════════════════════════════════════
   ④ 生命周期
   ══════════════════════════════════════════════════════════ */

/* 单实例：再点一次 exe 就聚焦已有窗口，而不是开第二个 */
const gotLock = HEADLESS || app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    log.info(`启动：Electron ${process.versions.electron} / Node ${process.versions.node}`)
    log.info(`数据目录：${DIRS.data}`)
    log.info(`参数：${process.argv.slice(1).join(' ')}`)
    log.info(`模式：self-test=${SELF_TEST} screenshot=${SCREENSHOT}`)

    /* 启动自检：数据目录只要落在 C 盘就报警 */
    for (const audit of auditNonC()) {
      if (!audit.ok) log.error(`⚠ ${audit.label} 落在 C 盘：${audit.dir}`)
    }

    /* 上一轮如果是被强杀/崩溃退出的，任务会卡在 running（续不了）—— 见 boot-cleanup.cjs */
    bootCleanup.sweepStaleTasks()

    createWindow()

    /* 托盘：自检/截图模式不需要（那两种模式要能干净退出） */
    if (!HEADLESS) setupTray({ onCreateWindow: createWindow, notify: trayNotifier?.notify })

    /* 自动备份：一天一次。便携版拷 U 盘时中途拔了，data 会残 —— 靠这个兜底 */
    try {
      const r = require('./core/backup.cjs').maybeAuto()
      log.info(r.skipped ? '自动备份：今天已经备过了' : `自动备份完成：${r.name}`)
    } catch (error) {
      log.warn(`自动备份失败：${error instanceof Error ? error.message : error}`)
    }

    /* MCP 后台启动：要 spawn 子进程并等握手（最多 20s），不能阻塞窗口显示 */
    void require('./core/mcp.cjs')
      .boot(config)
      .then(() => log.info('MCP 初始化完成'))
    pluginWatcher.install({ send }) // 插件热插拔：监听 data/plugins/，增删自动重扫 + 通知前端
    imageHandler.register({ send }) // 生图出图后：落盘 + 写会话 + 通知前端（见 handlers/image.cjs）

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  /*
   * 退出前必须把终端子进程杀干净。
   * 不杀的话每开一次窗口就漏一批 cmd.exe —— conpty 的子进程不会
   * 随着父进程退出自动结束，它们挂在 ConPTY 会话上。
   */
  app.on('will-quit', () => {
    bootCleanup.onQuit({ destroyTray })
  })
}

/* 渲染层用到的处理器：清单在 register-handlers.cjs（那边能一眼看全注册了哪些通道） */
trayNotifier = registerHandlers({
  ipcMain,
  app,
  Notification,
  config,
  log,
  send,
  streams,
  setQuitting,
  showWindow,
  getMainWindow: () => mainWindow,
  workdir: { currentWorkdir, resolveWorkdir },
}).notifier

module.exports = { currentWorkdir, send }
