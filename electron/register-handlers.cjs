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

const log = require('./core/log.cjs')
const actions = require('./core/log-actions.cjs')

/**
 * 慢调用阈值：超过它的成功调用也写一行主日志。
 * 定 1 秒是因为「界面点了没反应」基本都发生在秒级；几百毫秒的那种属于正常。
 */
const SLOW_IPC_MS = 1000

/**
 * 把 `ipcMain.handle` 包一层 —— **所有通道的兜底**。
 *
 * 为什么要它：一个通道抛异常，以前渲染层会收到错误、弹个 toast，
 * 而 `data/logs` 里**一个字都没有**（真机上就吃过这个亏：「消息发不出去」
 * 却查不到任何线索）。包在这里是最省事、也最全的位置 —— 加新通道自动被包上。
 *
 * 记两份：成败/耗时进**动作流水**（机器看），失败和慢调用另外进**主日志**（人看）。
 */
function wrapInvokeHandlers(ipcMain) {
  const raw = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) =>
    raw(channel, async (event, ...args) => {
      const at = Date.now()
      try {
        const result = await listener(event, ...args)
        const ms = Date.now() - at
        actions.record({ kind: 'ipc', name: channel, ok: true, ms })
        if (ms >= SLOW_IPC_MS) log.warn(`慢调用 ${channel}：${ms}ms`)
        return result
      } catch (error) {
        const ms = Date.now() - at
        const message = error instanceof Error ? error.message : String(error)
        actions.record({ kind: 'ipc', name: channel, ok: false, ms, detail: message })
        log.error(`通道失败 ${channel}（${ms}ms）：${message}`)
        throw error
      }
    })
}

function registerHandlers(deps) {
  const { ipcMain, app, Notification, config, log, send, streams, getMainWindow } = deps
  const { currentWorkdir, resolveWorkdir } = deps.workdir

  /* 先包一层，后面所有 register() 注册的通道都自动在网里 */
  wrapInvokeHandlers(ipcMain)

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

  require('./handlers/log.cjs').register({ ipcMain })
  require('./handlers/compact.cjs').register({ ipcMain })
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
  /* 成果（Artifact）：落盘 + 版本历史 + 打开文件，数据在 data/artifacts/ */
  require('./handlers/artifact.cjs').register({ ipcMain })
  /*
   * 定时任务：台账 CRUD + 立刻跑一次。
   * 心跳（30 秒一跳）不在这里起 —— 它要等 app ready，由 main.cjs 调
   * `handlers/schedules.cjs` 的 `start()`（同一处装配依赖，免得两套）。
   */
  const schedules = require('./handlers/schedules.cjs')
  schedules.register({ ipcMain })
  /* 项目（一等实体）：登记表在 data/projects.json，见 core/projects.cjs */
  require('./handlers/projects.cjs').register({ ipcMain })
  /* 个人资料（头像 + 名字）—— 侧栏左下角那个圆 */
  require('./handlers/profile.cjs').register({ ipcMain })

  /* 交给 main.cjs：藏到托盘时用它给用户一句「我还在这儿」 */
  return { notifier, schedules }
}

module.exports = { registerHandlers, wrapInvokeHandlers }
