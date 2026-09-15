/**
 * 启动自检与截图（`--self-test` / `--screenshot`）
 *
 * 从 main.cjs 拆出来的（那边过 300 行了）。这两个只在验收时用：
 *
 *   --self-test   无窗口启动，跑一遍关键链路然后打印 JSON 退出
 *   --screenshot  无窗口启动，截一张图存到 data/ 然后退出
 *
 * 自检的重点是那些**失败也不会让构建报错**的东西：真 PTY 能不能开、
 * 会话能不能落盘、临时目录有没有跑去 C 盘、渲染层的桥接在不在。
 * 每次打包完都该跑一次 —— 比「看着像好的」可靠。
 */

const path = require('node:path')
const fs = require('node:fs')
const { app, ipcMain } = require('electron')
const { DIRS, auditNonC } = require('./core/paths.cjs')
const log = require('./core/log.cjs')
const { EXPECTED_CHANNELS } = require('./ipc-channels.cjs')

/* ── 截图：给验收用 ─────────────────────────────────────── */

async function runScreenshot(win) {
  /* 等页面把异步初始化跑完（拉配置、读会话），否则截到的是初始状态 */
  await new Promise((resolve) => setTimeout(resolve, 2200))

  try {
    /* 用 CDP 直接拿画面：capturePage 在后台窗口会返回过期几帧的图 */
    const dbg = win.webContents.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' })
    const file = path.join(DIRS.data, 'shot-main.png')
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    log.info(`截图已保存：${file}`)
    console.log(`\n截图：${file}\n`)
  } catch (error) {
    log.error(`截图失败：${error instanceof Error ? error.message : error}`)
  }

  app.quit()
}

/* ── 自检：无窗口跑一遍，打印关键状态 ───────────────────── */

async function runSelfTest(win) {
  const { execFile } = require('node:child_process')
  const { promisify } = require('node:util')
  const run = promisify(execFile)

  const report = {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    dataDir: DIRS.data,
    audits: auditNonC(),
  }

  /*
   * 等一会儿再读数 —— 渲染层启动后还要异步做几件事：
   * 拉主进程配置、读会话列表。不等就读的话，看到的是初始的示例数据。
   * （这个延时本身也是踩过的坑：第一版自检报的标题还是示例标题）
   */
  await new Promise((resolve) => setTimeout(resolve, 1800))

  try {
    report.renderer = await win.webContents.executeJavaScript(`
      (async function () {
        // 等字体加载完再读，否则全是 unloaded
        try { await document.fonts.ready } catch (e) {}
        return {
          hasBridge: typeof window.workbench !== 'undefined',
          theme: document.documentElement.dataset.theme,
          glass: document.documentElement.dataset.glass,
          animations: document.documentElement.dataset.animations,
          rootChildren: document.getElementById('root')?.children.length ?? 0,
          title: document.querySelector('h1')?.textContent ?? '',
          sessionCount: (function () {
            try {
              return JSON.parse(localStorage.getItem('personal-agent:app') || '{}')?.state?.threads
                ?.length
            } catch (e) {
              return -1
            }
          })(),
          fonts: Array.from(document.fonts || [])
            .map(function (f) {
              return f.family + ' ' + f.weight + ' ' + f.status
            })
            .join(' / '),
          bodyFont: getComputedStyle(document.body).fontFamily,
        }
      })()
    `)
  } catch (error) {
    report.rendererError = String(error)
  }

  /* 顺便验一下进程内的临时文件有没有跑到 C 盘 */
  try {
    const { stdout } = await run('powershell', [
      '-NoProfile',
      '-Command',
      '[System.IO.Path]::GetTempPath()',
    ])
    report.tempPath = stdout.trim()
  } catch {
    report.tempPath = '(读不到)'
  }

  /* 再验一件事：主进程能不能真的建会话文件 */
  try {
    const sessionCore = require('./core/session.cjs')
    const probe = sessionCore.create({ title: '自检探针', mode: 'pair', model: 'probe' })
    const wrote = require('node:fs').existsSync(sessionCore.fileFor(probe.id))
    sessionCore.remove(probe.id)
    report.sessionWriteWorks = wrote
  } catch (error) {
    report.sessionWriteWorks = false
    report.sessionWriteError = String(error)
  }

  /* 验一下文件系统：工作目录能读 */
  try {
    const fsHandler = require('./handlers/fs.cjs')
    const wd = fsHandler.workdir()
    report.fsWorkdir = wd
    report.fsReadable = require('node:fs').readdirSync(wd).length >= 0
  } catch (error) {
    report.fsError = String(error)
  }

  /* 验一下终端：能真的 spawn 一条命令 */
  try {
    const { execFileSync } = require('node:child_process')
    const out = execFileSync('cmd', ['/c', 'echo probe'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    })
    report.shellWorks = out.includes('probe')
  } catch (error) {
    report.shellWorks = false
    report.shellError = String(error)
  }

  /*
   * 验一下真 PTY。
   *
   * 比上面那条「能 spawn 命令」重要得多 —— PTY 的失败方式很阴：
   * 原生模块 ABI 不对、预编译产物没打进包、conpty.dll 没跟着走，
   * 这三种都不会让构建报错，只是用户点开终端时看到一个红字。
   * 所以每次自检都真的开一次、写一条命令、看回显。
   */
  try {
    const pty = require('./core/pty.cjs')
    report.ptyLoads = true

    await new Promise((resolve) => {
      let raw = ''
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        pty.killAll()
        resolve()
      }

      const timer = setTimeout(done, 6000)
      const started = pty.start({
        id: 'self-test',
        cols: 80,
        rows: 24,
        onData: (chunk) => {
          raw += chunk
          /* 看到回显就收（里面带 ANSI 转义，所以清洗后再找） */
          const plain = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
          if (plain.includes('PTY_PROBE_OK')) {
            report.ptyWorks = true
            report.ptyAnsi = /\x1b\[/.test(raw)
            report.ptyBytes = raw.length
            done()
          }
        },
        onExit: (info) => {
          report.ptyShellExited = info.exitCode
          done()
        },
      })

      if (!started.ok) {
        report.ptyWorks = false
        report.ptyError = started.error
        done()
        return
      }
      report.ptyShell = started.shell
      pty.write('self-test', 'echo PTY_PROBE_OK\r\n')
    })
  } catch (error) {
    report.ptyWorks = false
    report.ptyError = error instanceof Error ? error.message : String(error)
  }

  /*
   * 通道清点 —— **这一条是补漏来的**。
   *
   * 主进程的 handler 注册块是**同步**跑的：中间任何一行抛错
   * （踩过的是「某个 handler 用了 ipcMain 却没 require electron」），
   * 它后面的 handler 就全都不注册。但 Electron 不会退出，只弹一个
   * 「A JavaScript error occurred in the main process」然后照常开窗口 ——
   * 于是「哪些功能哑了」要等用户点到才发现。
   *
   * 自检以前只查「能查的」，查不到这个。现在把该有的通道列出来挨个点名。
   */
  try {
    /*
     * 注意查法：`ipcMain.handle` 注册的通道**不在** eventNames 里
     * （那个只列 `.on` 注册的），listenerCount 对 handle 也恒为 0。
     * 真正存 handle 的是私有的 `_invokeHandlers` Map —— 实测过。
     * 私有 API 有失效风险，所以留了一条退路：真拿不到就退回 listenerCount。
     */
    const invokeHandlers = ipcMain._invokeHandlers
    const hasHandler = (channel) =>
      invokeHandlers && typeof invokeHandlers.has === 'function'
        ? invokeHandlers.has(channel)
        : ipcMain.listenerCount(channel) > 0
    report.channelsCheckMethod = invokeHandlers?.has ? '_invokeHandlers' : 'listenerCount(退路)'
    const missing = EXPECTED_CHANNELS.filter((channel) => !hasHandler(channel))
    report.channelsExpected = EXPECTED_CHANNELS.length
    report.channelsMissing = missing
    report.channelsOk = missing.length === 0
    if (missing.length > 0)
      log.error(`有 ${missing.length} 个 IPC 通道没注册上：${missing.join(', ')}`)
  } catch (error) {
    report.channelsOk = false
    report.channelsError = String(error)
  }

  console.log('\n════════ 自检结果 ════════')
  console.log(JSON.stringify(report, null, 2))
  console.log('══════════════════════════\n')

  app.quit()
}

module.exports = { runSelfTest, runScreenshot }
