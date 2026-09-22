/**
 * 预加载脚本 —— 主进程与渲染层之间唯一的桥
 *
 * 原则：**白名单**。渲染层能调什么，全在这个文件里列清楚，
 * 不做「暴露整个 ipcRenderer」那种偷懒写法。
 */

const { contextBridge, ipcRenderer } = require('electron')

/* onEvent 只转发这个通道。终端数据走 onShellData —— 混在一起形状对不上。 */
const EVENTS = ['chat:event']

/* ══════════════════════════════════════════════════════════════
   ★ 所有 IPC 都从 `call()` 过 —— 唯一出入口。

   这样「界面用了哪个功能」不用逐个埋点：现有通道全在网里，以后新加的也自动被记上。
   只报通道名/成败/耗时，**不报参数**。

   ★★ 必须留在**本文件**里：main.cjs 开的是 `sandbox: true`，沙箱化的 preload
     **不允许 require 自己的模块** —— 拆到兄弟文件那次 require 一抛，整个 preload
     作废（`window.workbench` 不存在、界面 IPC 全死）。真机探针逮到的。
   ══════════════════════════════════════════════════════════════ */
const stampNow = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()

function report(entry) {
  try {
    /* send 不等回执：记日志不能给界面加延迟，也不能因为失败把功能弄挂 */
    ipcRenderer.send('log:action', entry)
  } catch {
    /* 忽略 */
  }
}

function call(channel, ...args) {
  const at = stampNow()
  /* ★ 这里必须是 ipcRenderer.invoke：批量替换曾把这行也换成 call()，直接死递归 */
  return ipcRenderer.invoke(channel, ...args).then(
    (result) => {
      report({ kind: 'ipc', name: channel, ok: true, ms: stampNow() - at })
      return result
    },
    (error) => {
      report({
        kind: 'ipc',
        name: channel,
        ok: false,
        ms: stampNow() - at,
        detail: (error && error.message) || String(error),
      })
      throw error
    },
  )
}

const api = {
  selfTest: () => call('app:selfTest'),
  quitApp: () => call('app:quit'),
  showWindow: () => call('app:showWindow'),
  setTitleBar: (colors) => call('window:titleBar', colors),

  getConfig: () => call('config:get'),
  patchConfig: (partial) => call('config:patch', partial),
  resetConfig: () => call('config:reset'),

  pingProvider: (providerId) => call('provider:ping', providerId),
  listModels: (providerId) => call('provider:listModels', providerId),

  getWorkdir: () => call('workdir:get'),
  pickWorkdir: () => call('workdir:pick'),
  /** 只挑目录，不改全局默认（给单条对话挂目录用） */
  chooseFolder: () => call('workdir:choose'),

  listSessions: () => call('session:list'),
  searchSessions: (query, limit) => call('session:search', query, limit),
  listWorkdirs: () => call('session:workdirs'),
  createSession: (options) => call('session:create', options),
  loadSession: (id) => call('session:load', id),
  appendMessage: (id, message) => call('session:append', id, message),
  updateSessionMeta: (id, patch) => call('session:updateMeta', id, patch),
  removeSession: (id) => call('session:remove', id),
  removeAllSessions: () => call('session:removeAll'),
  sessionToApiMessages: (id, limit) => call('session:toApiMessages', id, limit),

  saveText: (payload) => call('export:saveText', payload),
  pickJson: () => call('import:pickJson'),
  importSessions: (list) => call('session:import', list),
  appendCompact: (id, summary, upTo) =>
    call('session:appendCompact', id, summary, upTo),

  listSkills: () => call('skills:list'),
  createSkill: (name, description) => call('skills:create', name, description),
  removeSkill: (id) => call('skills:remove', id),
  openSkillsDir: () => call('skills:openDir'),

  getMemory: () => call('memory:get'),
  setMemory: (text) => call('memory:set', text),
  clearMemory: () => call('memory:clear'),
  /* 结构化记忆 */
  memoryList: (options) => call('memory:list', options),
  memorySearch: (query, options) => call('memory:search', { query, ...options }),
  memoryAdd: (input) => call('memory:add', input),
  memoryUpdate: (payload) => call('memory:update', payload),
  memoryDisable: (id) => call('memory:disable', id),
  memoryEnable: (id) => call('memory:enable', id),
  memoryRemove: (id) => call('memory:remove', id),

  searchProviders: () => call('search:providers'),
  testSearch: (override) => call('search:test', override),

  diagnosticsCopy: () => call('diagnostics:copy'),
  diagnosticsSave: () => call('diagnostics:save'),
  diagnosticsOpenDir: () => call('diagnostics:openDir'),

  sceneSnapshot: () => call('scene:snapshot'),
  sceneTitle: (messages) => call('scene:title', { messages }),
  sceneOptimize: (text) => call('scene:optimize', { text }),
  sceneTranslate: (text) => call('scene:translate', { text }),
  sceneSuggest: (messages) => call('scene:suggest', { messages }),
  sceneOcr: (imageDataUrl) => call('scene:ocr', { imageDataUrl }),
  sceneImage: (prompt, size) => call('scene:image', { prompt, size }),

  fsWorkdir: () => call('fs:workdir'),
  fsTree: (dir) => call('fs:tree', dir),
  fsList: (dir) => call('fs:list', dir),
  fsRead: (file) => call('fs:read', file),
  fsReveal: (target) => call('fs:reveal', target),
  fsPickAndRead: () => call('fs:pickAndRead'),
  pickImageAsDataUrl: () => call('fs:pickImageAsDataUrl'),

  shellCwd: () => call('shell:cwd'),
  shellReset: () => call('shell:reset'),
  shellRun: (payload) => call('shell:run', payload),
  shellAbort: (requestId) => call('shell:abort', requestId),

  auditList: (options) => call('audit:list', options),
  auditStats: (days) => call('audit:stats', days),
  auditClear: () => call('audit:clear'),
  auditPrune: () => call('audit:prune'),
  riskClassify: (command) => call('risk:classify', command),

  capabilityList: () => call('capability:list'),
  capabilityGrant: (payload) => call('capability:grant', payload),
  capabilityRevoke: (target) => call('capability:revoke', target),
  capabilityRevokeAll: () => call('capability:revokeAll'),

  taskList: (options) => call('task:list', options),
  taskUnfinished: () => call('task:unfinished'),
  /* AG-012：重启后的恢复清单 */
  taskRecovery: () => call('task:recovery'),
  taskGet: (id) => call('task:get', id),
  taskDiagnose: (id) => call('task:diagnose', id),
  taskUpdate: (payload) => call('task:update', payload),
  /* 个人资料：名字进配置、头像存 data/avatars/ */
  profileGet: () => call('profile:get'),
  profileSetName: (name) => call('profile:setName', name),
  profilePickAvatar: () => call('profile:pickAvatar'),
  profileClearAvatar: () => call('profile:clearAvatar'),
  taskRemove: (id) => call('task:remove', id),
  taskRemoveMany: (options) => call('task:removeMany', options),
  taskPurge: (sessionId) => call('task:purge', sessionId),
  taskPauseRunning: () => call('task:pauseRunning'),

  changesetList: (options) => call('changeset:list', options),
  changesetGet: (id) => call('changeset:get', id),
  changesetRollback: (id) => call('changeset:rollback', id),
  changesetDiff: (payload) => call('changeset:diff', payload),
  metricsRecent: (payload) => call('metrics:recent', payload),

  credentialsStatus: () => call('credentials:status'),

  ptyStart: (payload) => call('pty:start', payload),
  ptyWrite: (payload) => call('pty:write', payload),
  ptyResize: (payload) => call('pty:resize', payload),
  ptyStop: (payload) => call('pty:stop', payload),
  ptyStopAll: () => call('pty:stopAll'),
  ptyList: () => call('pty:list'),

  statsSummary: () => call('stats:summary'),
  statsReset: () => call('stats:reset'),

  backupList: () => call('backup:list'),
  backupCreate: () => call('backup:create'),
  backupRestore: (name) => call('backup:restore', name),
  backupRemove: (name) => call('backup:remove', name),
  backupOpen: () => call('backup:open'),

  mcpStatus: () => call('mcp:status'),
  mcpPresets: () => call('mcp:presets'),
  mcpRestart: () => call('mcp:restart'),

  sendChat: (payload) => call('chat:send', payload),
  abortChat: (requestId) => call('chat:abort', requestId),
  /* AG-011：暂停（做完手上这步就往回走，不是立刻断） */
  pauseChat: (requestId) => call('chat:pause', requestId),
  confirmChat: (confirmId, approved) => call('chat:confirm', confirmId, approved),
  compactChat: (payload) => call('chat:compact', payload),

  /**
   * 订阅流式事件。返回取消订阅的函数。
   * 只转发白名单里的通道，别的通道一律丢掉。
   */
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload)
    for (const channel of EVENTS) ipcRenderer.on(channel, listener)
    return () => {
      for (const channel of EVENTS) ipcRenderer.removeListener(channel, listener)
    }
  },

  /** 只订阅终端输出。和 onEvent 分开，免得终端数据混进对话流里 */
  onShellData: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('shell:data', listener)
    return () => ipcRenderer.removeListener('shell:data', listener)
  },

  /* 订阅 PTY 两个事件（输出分片 / 退出）。合成一个回调：终端面板总是两个都要处理。 */
  onPtyEvent: (callback) => {
    const onData = (_event, payload) => callback({ type: 'data', ...payload })
    const onExit = (_event, payload) => callback({ type: 'exit', ...payload })
    ipcRenderer.on('pty:data', onData)
    ipcRenderer.on('pty:exit', onExit)
    return () => {
      ipcRenderer.removeListener('pty:data', onData)
      ipcRenderer.removeListener('pty:exit', onExit)
    }
  },

  /** 订阅插件热插拔事件（新增/删除插件时主进程通知） */
  onPluginsChanged: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('plugins:changed', handler)
    return () => ipcRenderer.removeListener('plugins:changed', handler)
  },

  /* 订阅「生图完成 / 失败」。生图是异步的（提交完就返回，出图可能几分钟后），
     那时这轮对话早结束了 —— 靠主进程推事件回来把图插进对话。 */
  onImageDone: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('image:ready', handler)
    ipcRenderer.on('image:failed', handler)
    ipcRenderer.on('image:progress', handler)
    return () => {
      ipcRenderer.removeListener('image:ready', handler)
      ipcRenderer.removeListener('image:failed', handler)
      ipcRenderer.removeListener('image:progress', handler)
    }
  },


  /** 主进程发来的浏览请求（要操作 webview + 回话，见 useBrowseBridge.ts） */
  onBrowserRequest: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('browser:request', handler)
    return () => ipcRenderer.removeListener('browser:request', handler)
  },


  /* 一轮跑完了（主进程推）。**文案由主进程算好**（要不要弹系统通知是它决定的，
     藏到托盘时渲染层会被节流判不准）；渲染层只负责"用户没在看就弹个提示"。 */
  onTaskEnd: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('app:taskEnd', handler)
    return () => ipcRenderer.removeListener('app:taskEnd', handler)
  },

  /** 用户点了系统通知 —— 主进程把窗口叫回来，再推这条给渲染层跳到那条任务 */
  onNotificationClick: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('app:notificationClick', handler)
    return () => ipcRenderer.removeListener('app:notificationClick', handler)
  },

  /** 把浏览结果回给主进程（不回的话那边会一直等） */
  browserResult: (id, result) => call('browser:result', { id, result }),

  /* 界面动作（点击了哪个功能）—— 只报动作名。渲染层全量点击监听用它。 */
  logAction: (entry) => report(entry),

  /** 渲染层没被捕获的异常（window.onerror / unhandledrejection / ErrorBoundary） */
  logError: (entry) => {
    try {
      ipcRenderer.send('log:error', entry)
    } catch {
      /* 忽略 */
    }
  },

  /** 渲染层可以据此判断「我是不是跑在 Electron 里」 */
  isElectron: true,
}

contextBridge.exposeInMainWorld('workbench', api)
