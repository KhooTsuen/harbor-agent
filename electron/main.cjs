/**
 * 主进程
 *
 * 职责：
 *   ① **在 app ready 之前**把所有 Electron 的路径锁到 data/ 下（绝不写 C 盘）
 *   ② 建窗口、装配 IPC
 *   ③ 转发流式事件给渲染层
 *
 * 注意：这个文件不做具体业务，业务在 core/ 和 handlers/ 里。
 */

const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu } = require('electron')

const { DIRS, ensureDirs, auditNonC, markPackaged } = require('./core/paths.cjs')
const log = require('./core/log.cjs')
const config = require('./core/config.cjs')
const { runSelfTest, runScreenshot } = require('./selftest-report.cjs')
const { currentWorkdir, resolveWorkdir } = require('./handlers/workdir.cjs')
const { setupTray, showWindow, setQuitting, isQuitting } = require('./tray.cjs')
const windowState = require('./window-state.cjs')

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
    title: 'Personal Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webviewTag: true,
    },
  })

  windowState.set(win)
  mainWindow = win

  win.once('ready-to-show', () => {
    if (!HEADLESS) win.show()
  })

  /* 外链一律用系统浏览器打开，不在应用里跳走 */
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
    win.hide()
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

    createWindow()

    /* 托盘：自检/截图模式不需要（那两种模式要能干净退出） */
    if (!HEADLESS) setupTray({ onCreateWindow: createWindow })

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
    try {
      require('./core/pty.cjs').killAll()
    } catch (error) {
      log.warn(`清理终端会话失败：${error instanceof Error ? error.message : error}`)
    }

    /* 没干完的任务标成「暂停」—— 下次启动才认得出该提示用户续做 */
    try {
      require('./core/task.cjs').pauseRunning()
    } catch (error) {
      log.warn(`标记任务状态失败：${error instanceof Error ? error.message : error}`)
    }
  })
}

ipcMain.handle('app:quit', () => {
  setQuitting(true)
  app.quit()
})

ipcMain.handle('app:showWindow', () => {
  showWindow()
  return { ok: true }
})

/* 渲染层的请求走 handlers/ 注册 */
require('./handlers/chat.cjs').register({
  ipcMain,
  config,
  log,
  send,
  streams,
  getWorkdir: currentWorkdir,
  resolveWorkdir,
})
require('./handlers/session.cjs').register({ ipcMain })
require('./handlers/provider.cjs').register({ ipcMain })
require('./handlers/export.cjs').register({ ipcMain, getMainWindow: () => mainWindow })
require('./handlers/skills.cjs').register({ ipcMain })
require('./handlers/extras.cjs').register({ ipcMain })
require('./handlers/fs.cjs').register({ ipcMain })
require('./handlers/shell.cjs').register({ ipcMain })
require('./handlers/scene.cjs').register({ ipcMain })
require('./handlers/diagnostics.cjs').register({ ipcMain })
/* 终端（真 PTY）：单独一组通道，和 shell.cjs 的「一次性执行」并存 */
require('./handlers/pty.cjs').register({ ipcMain, send, getWorkdir: currentWorkdir })
/* 安全 / 可靠相关：审计、路径授权、任务、改动事务、凭证状态 */
require('./handlers/safety.cjs').register({ ipcMain })

module.exports = { currentWorkdir, send }
