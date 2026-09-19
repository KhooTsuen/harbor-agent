/**
 * IPC 处理器注册清单
 *
 * 从 `main.cjs` 拆出来的 —— 加一条通道就撞 300 行上限（AG-029 加系统通知时
 * 已经拆无可拆，只能把整块清单搬出来）。
 *
 * 搬出来还有个好处：**「谁注册了哪些通道」一眼看得全**。
 * 这里少注册一个不会报错、只会「点那个按钮没反应」，所以
 * `electron/ipc-channels.cjs` 那份写死的通道清单在自检里挨个点名
 * （`channelsMissing`），漏一个就会红。
 *
 * 不在这个清单里的两个（它们有各自的时机）：
 *   · `handlers/workdir.cjs` —— 自己在模块加载时注册（main.cjs 顶部就 require 了）
 *   · `handlers/image.cjs`   —— 在 app ready 之后注册（要用窗口的 send）
 *
 * 依赖一律注入，这个文件自己不 require electron。
 */

function registerHandlers(deps) {
  const { ipcMain, app, Notification, config, log, send, streams, getMainWindow } = deps
  const { currentWorkdir, resolveWorkdir } = deps.workdir

  /* 窗口外观 + 显示/退出（见 handlers/window.cjs） */
  require('./handlers/window.cjs').register({
    ipcMain,
    app,
    setQuitting: deps.setQuitting,
    showWindow: deps.showWindow,
    getMainWindow,
  })

  /* AG-029：任务结束的通知（系统通知 + 推给渲染层显示应用内提示） */
  const notifier = require('./handlers/notify.cjs').createTaskNotifier({
    Notification,
    app,
    showWindow: deps.showWindow,
    getMainWindow,
  })

  require('./handlers/chat.cjs').register({
    ipcMain,
    config,
    log,
    send,
    streams,
    getWorkdir: currentWorkdir,
    resolveWorkdir,
    taskEnd: notifier.onRunEnd,
  })
  require('./handlers/session.cjs').register({ ipcMain })
  require('./handlers/provider.cjs').register({ ipcMain })
  /* 让主进程能驱动渲染层那个内嵌浏览器（<webview> 在主进程碰不到） */
  require('./handlers/browser.cjs').register()
  require('./handlers/export.cjs').register({ ipcMain, getMainWindow })
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

  /* 交给 main.cjs：藏到托盘时用它给用户一句「我还在这儿」 */
  return { notifier }
}

module.exports = { registerHandlers }
