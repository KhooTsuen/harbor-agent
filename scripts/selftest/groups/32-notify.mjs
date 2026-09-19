import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'
import Module from 'node:module'

/* ══════════════════════════════════════════════════════════════
   AG-029：后台任务通知（主进程这一半）

   为什么要在这里而不是渲染层测内容：**要发系统通知的是主进程** ——
   「窗口是不是被用户看着」只有它分得清（isMinimized / isVisible / isFocused），
   所以「跑完没有 / 要不要弹 / 文案是什么」全在主进程。
   内容生成一次（`core/task-notify.cjs`），系统通知和应用内提示共用。

   盯这几件事：
     ① 文案：「名字 / 改了 N 个文件 / 结果首行」；自己按的停止不通知
     ② 窗口在不在前台决定弹不弹系统通知（这是这个功能唯一的场景）
     ③ 点通知 → 叫回窗口 + 把 id 推回渲染层
     ④ 注册清单真的把每条通道都注册了（文本守卫挡不住「把注册那行注释掉」）
   ══════════════════════════════════════════════════════════════ */

const taskNotify = require(join(ROOT, 'electron/core/task-notify.cjs'))
const notifierModule = require(join(ROOT, 'electron/handlers/notify.cjs'))
const channels = require(join(ROOT, 'electron/ipc-channels.cjs'))

function fakeTask(patch = {}) {
  return {
    id: 'task-1',
    title: '重构执行引擎',
    goal: '重构执行引擎',
    status: 'completed',
    changedFiles: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }],
    errors: [],
    result: '测试通过\n其余细节……',
    ...patch,
  }
}

/** 假 Notification：记录弹了什么，点击回调留着测试触发 */
function fakeNotification({ supported = true, throwOnShow = false } = {}) {
  const shown = []
  class FakeNotification {
    static isSupported() {
      return supported
    }
    constructor(options) {
      this.options = options
    }
    on(event, cb) {
      if (event === 'click') this.clickHandler = cb
    }
    show() {
      if (throwOnShow) throw new Error('系统拒绝弹通知')
      shown.push(this)
    }
  }
  return { FakeNotification, shown }
}

function fakeWindow({ visible = true, focused = true, minimized = false } = {}) {
  const sent = []
  return {
    sent,
    win: {
      isVisible: () => visible,
      isFocused: () => focused,
      isMinimized: () => minimized,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    },
  }
}

export async function run() {
  group('系统通知 / 文案')
  const done = taskNotify.endNotice('completed', fakeTask())
  check('完成：名字 + 改了 N 个文件 + 结果首行', done?.description === '「重构执行引擎」\n已修改 3 个文件\n测试通过', done?.description)
  check('完成用 success 样式', done?.kind === 'success' && done?.title === '后台任务完成')

  const noFiles = taskNotify.endNotice('completed', fakeTask({ changedFiles: [] }))
  check('没改文件也说实话', noFiles?.description.includes('没有改动文件'))

  const failed = taskNotify.endNotice('failed', fakeTask({ status: 'failed', result: '', errors: [{ message: 'npm test 退出码 1' }] }))
  check('失败：说错误原因', failed?.kind === 'error' && failed?.description.includes('npm test 退出码 1'))

  check('没有任务记录也能出通知', taskNotify.endNotice('completed')?.description === '「未命名任务」')
  check('★ 用户自己按的停止不通知', taskNotify.endNotice('cancelled', fakeTask({ status: 'cancelled' })) === null)
  check('暂停 / 等待 / 其他状态都不通知', ['paused', 'waiting_user', 'running', 'idle'].every((s) => taskNotify.endNotice(s, fakeTask({ status: s })) === null))

  group('系统通知 / 要不要弹')
  /* 任务台账：让 notifier 查到「这条对话最近的任务」 */
  const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
  const sessionId = 'sess-ag029-notify'
  const task = taskCore.create({ goal: '重构执行引擎', sessionId })
  taskCore.setPlan(task.id, ['[x] 分析'], { title: '重构执行引擎' })
  taskCore.update(task.id, { changedFiles: [{ path: 'a.ts', at: 1 }] })
  taskCore.finish(task.id, { status: 'completed', result: '测试通过' })

  /* 窗口不在前台（最小化 / 被别的窗口盖住）：必须弹系统通知 */
  const bg = fakeWindow({ visible: false, focused: false })
  const { FakeNotification, shown } = fakeNotification()
  const notifier = notifierModule.createTaskNotifier({
    Notification: FakeNotification,
    app: {},
    showWindow: () => {},
    getMainWindow: () => bg.win,
  })
  await notifier.onRunEnd({ sessionId })
  check('★ 窗口不在前台 → 弹系统通知', shown.length === 1, String(shown.length))
  check('通知内容 = 文案', shown[0]?.options?.title === '后台任务完成' && shown[0]?.options?.body.includes('重构执行引擎'))
  check('★ 同时推给渲染层（应用内提示用同一份文案）', bg.sent[0]?.channel === 'app:taskEnd' && bg.sent[0]?.payload?.kind === 'success', JSON.stringify(bg.sent[0] ?? null))

  /* 窗口在前台：不弹系统通知，只推给渲染层（由它决定弹不弹应用内提示） */
  const fg = fakeWindow({ visible: true, focused: true })
  const fgFake = fakeNotification()
  const fgNotifier = notifierModule.createTaskNotifier({
    Notification: fgFake.FakeNotification,
    app: {},
    showWindow: () => {},
    getMainWindow: () => fg.win,
  })
  await fgNotifier.onRunEnd({ sessionId })
  check('窗口在前台 → 不弹系统通知', fgFake.shown.length === 0)
  check('但仍然推给渲染层（它自己判断要不要提示）', fg.sent.length === 1)

  /*
   * ★ 最小化（用户最常用的那个场景）：Windows 上最小化之后 isVisible() 可能
   * 仍是 true、isFocused() 是 false —— 只看这两个会漏判，必须显式看 isMinimized()。
   */
  const min = fakeWindow({ visible: true, focused: true, minimized: true })
  const minFake = fakeNotification()
  const minNotifier = notifierModule.createTaskNotifier({
    Notification: minFake.FakeNotification,
    app: {},
    showWindow: () => {},
    getMainWindow: () => min.win,
  })
  await minNotifier.onRunEnd({ sessionId })
  check(
    '★ 窗口最小化 → 弹系统通知（哪怕 isVisible / isFocused 还说「正常」）',
    minFake.shown.length === 1,
    String(minFake.shown.length),
  )

  /* 点通知：叫回窗口 + 推事件 */
  let shownWindow = 0
  const clickable = fakeNotification()
  const clickWin = fakeWindow({ visible: false, focused: false })
  const clickNotifier = notifierModule.createTaskNotifier({
    Notification: clickable.FakeNotification,
    app: {},
    showWindow: () => {
      shownWindow += 1
    },
    getMainWindow: () => clickWin.win,
  })
  await clickNotifier.onRunEnd({ sessionId })
  clickable.shown[0]?.clickHandler?.()
  check('★ 点通知叫回窗口', shownWindow === 1)
  check(
    '★ 并把 id 推回渲染层（渲染层据此跳到那条任务）',
    clickWin.sent.some((m) => m.channel === 'app:notificationClick' && m.payload.id === sessionId),
    JSON.stringify(clickWin.sent.map((m) => m.channel)),
  )

  /* 平台不支持 / show 抛错：不能把主进程带崩 */
  const bad = fakeNotification({ supported: false })
  const badNotifier = notifierModule.createTaskNotifier({
    Notification: bad.FakeNotification,
    app: {},
    showWindow: () => {},
    getMainWindow: () => fakeWindow({ visible: false, focused: false }).win,
  })
  await badNotifier.onRunEnd({ sessionId })
  check('平台不支持也不炸（只记一条 warn）', true)
  const throwing = fakeNotification({ throwOnShow: true })
  const throwingNotifier = notifierModule.createTaskNotifier({
    Notification: throwing.FakeNotification,
    app: {},
    showWindow: () => {},
    getMainWindow: () => fakeWindow({ visible: false, focused: false }).win,
  })
  await throwingNotifier.onRunEnd({ sessionId })
  check('show 抛错被接住', true)

  taskCore.remove(task.id)

  group('系统通知 / 接线')
  const chatSrc = readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8')
  check('★ 收尾时（finally）通知，成功/失败/中断都走', /finally \{[\s\S]{0,400}taskEnd\?\.\(/.test(chatSrc))
  const hookSrc = readFileSync(join(ROOT, 'src/hooks/useTaskNotifications.ts'), 'utf8')
  check('渲染层只订阅 taskEnd（不再自己盯相位）', hookSrc.includes('subscribeTaskEnd('))
  check('渲染层不再自己拼通知文案', !hookSrc.includes('endNotice'))
  const preloadSrc = readFileSync(join(ROOT, 'electron/preload.cjs'), 'utf8')
  check('preload 订阅了 app:taskEnd', preloadSrc.includes("ipcRenderer.on('app:taskEnd'"))
  check('preload 订阅了点击事件', preloadSrc.includes("ipcRenderer.on('app:notificationClick'"))
  check(
    '★ 注册清单把通知器接到了对话收尾上（不是建了不用）',
    readFileSync(join(ROOT, 'electron/register-handlers.cjs'), 'utf8').includes('taskEnd: notifier.onRunEnd'),
  )

  /*
   * ★ 真的跑一遍注册。
   *
   * 上面那些都是**文本断言**，挡不住「把注册那行注释掉」（变异测试证明过）。
   * 所以这里给模块加载器塞一个假 electron，真调一次 registerHandlers，
   * 再拿整份通道清单核对 —— 等价于 Electron 自检里的 channelsMissing。
   *
   * handlers/ 下有几个模块在模块加载时就 require electron（browser / export /
   * diagnostics / skills），所以纯 Node 里必须先把假 electron 挂上。
   */
  const registeredChannels = []
  const recordingIpcMain = { handle: (channel) => registeredChannels.push(channel) }
  const fakeElectron = {
    ipcMain: recordingIpcMain,
    BrowserWindow: class {},
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    shell: { openPath: async () => {}, showItemInFolder: () => {} },
    clipboard: { writeText: () => {} },
    app: { setAppUserModelId: () => {}, getPath: () => '' },
    Notification: class {
      static isSupported() {
        return true
      }
      show() {}
      on() {}
    },
  }

  const originalLoad = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'electron') return fakeElectron
    return originalLoad.call(this, request, ...rest)
  }
  try {
    const { registerHandlers } = require(join(ROOT, 'electron/register-handlers.cjs'))
    registerHandlers({
      ipcMain: recordingIpcMain,
      app: fakeElectron.app,
      Notification: fakeElectron.Notification,
      config: { general: {} },
      log: { info() {}, warn() {}, error() {} },
      send: () => {},
      streams: new Map(),
      setQuitting: () => {},
      showWindow: () => {},
      getMainWindow: () => null,
      workdir: { currentWorkdir: () => '', resolveWorkdir: () => '' },
    })
  } finally {
    Module._load = originalLoad
  }

  /*
   * 清单上除了这几条「早有归属」的，其余必须全由这份清单注册 ——
   * 少一条都会在这里变红（而不是等用户点到那个按钮才发现没反应）。
   *
   *   · app:selfTest / config:*  → main.cjs 里直接注册（自检要用）
   *   · workdir:*                → handlers/workdir.cjs 在模块加载时自己注册
   */
  const elsewhere = [
    'app:selfTest',
    'config:get',
    'config:patch',
    'config:reset',
    'workdir:get',
    'workdir:choose',
    'workdir:pick',
  ]
  const missing = channels.EXPECTED_CHANNELS.filter((c) => !registeredChannels.includes(c))
  check(
    '★ 通道清单上的通道都真被注册了（缺口只能是那几条早有归属的）',
    missing.every((c) => elsewhere.includes(c)),
    `没注册：${missing.join(', ')}`,
  )
  check(
    '★ 反过来：注册了但不在清单里的（清单要完整）',
    registeredChannels.every((c) => channels.EXPECTED_CHANNELS.includes(c)),
    registeredChannels.filter((c) => !channels.EXPECTED_CHANNELS.includes(c)).join(', '),
  )
}
