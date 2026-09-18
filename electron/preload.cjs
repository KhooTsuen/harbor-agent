/**
 * 预加载脚本 —— 主进程与渲染层之间唯一的桥
 *
 * 原则：**白名单**。渲染层能调什么，全在这个文件里列清楚，
 * 不做「暴露整个 ipcRenderer」那种偷懒写法。
 */

const { contextBridge, ipcRenderer } = require('electron')

/**
 * onEvent 只转发的通道。
 * 终端数据走单独的 onShellData —— 混在一起会让对话的事件回调收到终端分片，
 * 而两者的 payload 形状不一样。
 */
const EVENTS = ['chat:event']

const api = {
  /* ── 应用 ─────────────────────────────────────────────── */
  selfTest: () => ipcRenderer.invoke('app:selfTest'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  showWindow: () => ipcRenderer.invoke('app:showWindow'),
  setTitleBar: (colors) => ipcRenderer.invoke('window:titleBar', colors),

  /* ── 配置 ─────────────────────────────────────────────── */
  getConfig: () => ipcRenderer.invoke('config:get'),
  patchConfig: (partial) => ipcRenderer.invoke('config:patch', partial),
  resetConfig: () => ipcRenderer.invoke('config:reset'),

  /* ── 供应商 ───────────────────────────────────────────── */
  pingProvider: (providerId) => ipcRenderer.invoke('provider:ping', providerId),
  listModels: (providerId) => ipcRenderer.invoke('provider:listModels', providerId),

  /* ── 工作目录 ─────────────────────────────────────────── */
  getWorkdir: () => ipcRenderer.invoke('workdir:get'),
  pickWorkdir: () => ipcRenderer.invoke('workdir:pick'),
  /** 只挑目录，不改全局默认（给单条对话挂目录用） */
  chooseFolder: () => ipcRenderer.invoke('workdir:choose'),

  /* ── 会话 ─────────────────────────────────────────────── */
  listSessions: () => ipcRenderer.invoke('session:list'),
  searchSessions: (query, limit) => ipcRenderer.invoke('session:search', query, limit),
  listWorkdirs: () => ipcRenderer.invoke('session:workdirs'),
  createSession: (options) => ipcRenderer.invoke('session:create', options),
  loadSession: (id) => ipcRenderer.invoke('session:load', id),
  appendMessage: (id, message) => ipcRenderer.invoke('session:append', id, message),
  updateSessionMeta: (id, patch) => ipcRenderer.invoke('session:updateMeta', id, patch),
  removeSession: (id) => ipcRenderer.invoke('session:remove', id),
  removeAllSessions: () => ipcRenderer.invoke('session:removeAll'),
  sessionToApiMessages: (id, limit) => ipcRenderer.invoke('session:toApiMessages', id, limit),

  /* ── 导出 ─────────────────────────────────────────────── */
  saveText: (payload) => ipcRenderer.invoke('export:saveText', payload),
  pickJson: () => ipcRenderer.invoke('import:pickJson'),
  importSessions: (list) => ipcRenderer.invoke('session:import', list),
  appendCompact: (id, summary, upTo) =>
    ipcRenderer.invoke('session:appendCompact', id, summary, upTo),

  /* ── 技能 ─────────────────────────────────────────────── */
  listSkills: () => ipcRenderer.invoke('skills:list'),
  createSkill: (name, description) => ipcRenderer.invoke('skills:create', name, description),
  removeSkill: (id) => ipcRenderer.invoke('skills:remove', id),
  openSkillsDir: () => ipcRenderer.invoke('skills:openDir'),

  /* ── 记忆 ─────────────────────────────────────────────── */
  getMemory: () => ipcRenderer.invoke('memory:get'),
  setMemory: (text) => ipcRenderer.invoke('memory:set', text),
  clearMemory: () => ipcRenderer.invoke('memory:clear'),
  /* 结构化记忆 */
  memoryList: (options) => ipcRenderer.invoke('memory:list', options),
  memorySearch: (query) => ipcRenderer.invoke('memory:search', query),
  memoryAdd: (input) => ipcRenderer.invoke('memory:add', input),
  memoryUpdate: (payload) => ipcRenderer.invoke('memory:update', payload),
  memoryDisable: (id) => ipcRenderer.invoke('memory:disable', id),
  memoryEnable: (id) => ipcRenderer.invoke('memory:enable', id),
  memoryRemove: (id) => ipcRenderer.invoke('memory:remove', id),

  /* ── 搜索 ─────────────────────────────────────────────── */
  searchProviders: () => ipcRenderer.invoke('search:providers'),
  testSearch: (override) => ipcRenderer.invoke('search:test', override),

  /* ── 诊断 ─────────────────────────────────────────────── */
  diagnosticsCopy: () => ipcRenderer.invoke('diagnostics:copy'),
  diagnosticsSave: () => ipcRenderer.invoke('diagnostics:save'),
  diagnosticsOpenDir: () => ipcRenderer.invoke('diagnostics:openDir'),

  /* ── 场景（标题 / 优化 / 翻译 / 建议 / OCR / 画图）───────── */
  sceneSnapshot: () => ipcRenderer.invoke('scene:snapshot'),
  sceneTitle: (messages) => ipcRenderer.invoke('scene:title', { messages }),
  sceneOptimize: (text) => ipcRenderer.invoke('scene:optimize', { text }),
  sceneTranslate: (text) => ipcRenderer.invoke('scene:translate', { text }),
  sceneSuggest: (messages) => ipcRenderer.invoke('scene:suggest', { messages }),
  sceneOcr: (imageDataUrl) => ipcRenderer.invoke('scene:ocr', { imageDataUrl }),
  sceneImage: (prompt, size) => ipcRenderer.invoke('scene:image', { prompt, size }),

  /* ── 文件系统 ─────────────────────────────────────────── */
  fsWorkdir: () => ipcRenderer.invoke('fs:workdir'),
  fsTree: (dir) => ipcRenderer.invoke('fs:tree', dir),
  fsList: (dir) => ipcRenderer.invoke('fs:list', dir),
  fsRead: (file) => ipcRenderer.invoke('fs:read', file),
  fsReveal: (target) => ipcRenderer.invoke('fs:reveal', target),
  fsPickAndRead: () => ipcRenderer.invoke('fs:pickAndRead'),
  pickImageAsDataUrl: () => ipcRenderer.invoke('fs:pickImageAsDataUrl'),

  /* ── 终端 ─────────────────────────────────────────────── */
  shellCwd: () => ipcRenderer.invoke('shell:cwd'),
  shellReset: () => ipcRenderer.invoke('shell:reset'),
  shellRun: (payload) => ipcRenderer.invoke('shell:run', payload),
  shellAbort: (requestId) => ipcRenderer.invoke('shell:abort', requestId),

  /* ── 审计 / 授权 / 任务 / 改动事务 ─────────────────────── */
  auditList: (options) => ipcRenderer.invoke('audit:list', options),
  auditStats: (days) => ipcRenderer.invoke('audit:stats', days),
  auditClear: () => ipcRenderer.invoke('audit:clear'),
  auditPrune: () => ipcRenderer.invoke('audit:prune'),
  riskClassify: (command) => ipcRenderer.invoke('risk:classify', command),

  capabilityList: () => ipcRenderer.invoke('capability:list'),
  capabilityGrant: (payload) => ipcRenderer.invoke('capability:grant', payload),
  capabilityRevoke: (target) => ipcRenderer.invoke('capability:revoke', target),
  capabilityRevokeAll: () => ipcRenderer.invoke('capability:revokeAll'),

  taskList: (options) => ipcRenderer.invoke('task:list', options),
  taskUnfinished: () => ipcRenderer.invoke('task:unfinished'),
  taskGet: (id) => ipcRenderer.invoke('task:get', id),
  taskUpdate: (payload) => ipcRenderer.invoke('task:update', payload),
  taskRemove: (id) => ipcRenderer.invoke('task:remove', id),
  taskPauseRunning: () => ipcRenderer.invoke('task:pauseRunning'),

  changesetList: (options) => ipcRenderer.invoke('changeset:list', options),
  changesetGet: (id) => ipcRenderer.invoke('changeset:get', id),
  changesetRollback: (id) => ipcRenderer.invoke('changeset:rollback', id),

  credentialsStatus: () => ipcRenderer.invoke('credentials:status'),

  /* ── 真终端（PTY）─────────────────────────────────────── */
  ptyStart: (payload) => ipcRenderer.invoke('pty:start', payload),
  ptyWrite: (payload) => ipcRenderer.invoke('pty:write', payload),
  ptyResize: (payload) => ipcRenderer.invoke('pty:resize', payload),
  ptyStop: (payload) => ipcRenderer.invoke('pty:stop', payload),
  ptyStopAll: () => ipcRenderer.invoke('pty:stopAll'),
  ptyList: () => ipcRenderer.invoke('pty:list'),

  /* ── 用量统计 ─────────────────────────────────────────── */
  statsSummary: () => ipcRenderer.invoke('stats:summary'),
  statsReset: () => ipcRenderer.invoke('stats:reset'),

  /* ── 备份 ─────────────────────────────────────────────── */
  backupList: () => ipcRenderer.invoke('backup:list'),
  backupCreate: () => ipcRenderer.invoke('backup:create'),
  backupRestore: (name) => ipcRenderer.invoke('backup:restore', name),
  backupRemove: (name) => ipcRenderer.invoke('backup:remove', name),
  backupOpen: () => ipcRenderer.invoke('backup:open'),

  /* ── MCP ──────────────────────────────────────────────── */
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpRestart: () => ipcRenderer.invoke('mcp:restart'),

  /* ── 对话 ─────────────────────────────────────────────── */
  sendChat: (payload) => ipcRenderer.invoke('chat:send', payload),
  abortChat: (requestId) => ipcRenderer.invoke('chat:abort', requestId),
  /* AG-011：暂停（做完手上这步就往回走，不是立刻断） */
  pauseChat: (requestId) => ipcRenderer.invoke('chat:pause', requestId),
  confirmChat: (confirmId, approved) => ipcRenderer.invoke('chat:confirm', confirmId, approved),
  compactChat: (payload) => ipcRenderer.invoke('chat:compact', payload),

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

  /**
   * 订阅 PTY 的两个事件（输出分片 / 进程退出）。
   * 分开一个回调而不是两个：终端面板总是两个都要处理，
   * 拆成两个订阅函数只会让调用方多写三行清理代码。
   */
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

  /**
   * 订阅「生图完成 / 失败」。
   *
   * 生图是异步的：工具提交完就返回了，真正出图可能要好几分钟 ——
   * 那时对话早就结束一轮了，所以靠主进程推事件回来把图片插进对话。
   */
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

  /* ── 浏览器：让主进程的 `browse` 工具能驱动这个 webview ── */

  /** 主进程发来的浏览请求（要操作 webview + 回话，见 useBrowseBridge.ts） */
  onBrowserRequest: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('browser:request', handler)
    return () => ipcRenderer.removeListener('browser:request', handler)
  },

  /** 把浏览结果回给主进程（不回的话那边会一直等） */
  browserResult: (id, result) => ipcRenderer.invoke('browser:result', { id, result }),

  /** 渲染层可以据此判断「我是不是跑在 Electron 里」 */
  isElectron: true,
}

contextBridge.exposeInMainWorld('workbench', api)
