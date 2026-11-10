const { contextBridge, ipcRenderer } = require('electron')
const EVENTS = ['chat:event']

/* ══════════════════════════════════════════════════════════════
   ★ 所有 IPC 都从 `call()` 过 —— 唯一出入口：只报通道名 / 成败 / 耗时，**不报参数**。
   ★★ 必须留在**本文件**里：main.cjs 开的是 `sandbox: true`，沙箱化的 preload 不允许 require
   自己的模块 —— 拆到兄弟文件那次 require 一抛，整个 preload 作废、界面 IPC 全死（真机逮到的）。
   ══════════════════════════════════════════════════════════════ */
const stampNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function report(entry) {
  try {
    ipcRenderer.send('log:action', entry)
  } catch {}
}

function call(channel, ...args) {
  const at = stampNow()
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
function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}
function subscribeAll(channels, callback) {
  const offs = channels.map((channel) => subscribe(channel, callback))
  return () => offs.forEach((off) => off())
}

const api = {
  selfTest: () => call('app:selfTest'),
  quitApp: () => call('app:quit'),
  showWindow: () => call('app:showWindow'),
  setTitleBar: (colors) => call('window:titleBar', colors),
  getConfig: () => call('config:get'),
  patchConfig: (partial) => call('config:patch', partial),
  resetConfig: () => call('config:reset'),
  codexMcpStatus: () => call('codexMcp:status'),
  codexMcpSet: (partial) => call('codexMcp:set', partial),
  projectTestsStatus: () => call('projectTests:status'),
  projectTestsSet: (partial) => call('projectTests:set', partial),
  collabStatus: () => call('collab:status'),
  collabSet: (partial) => call('collab:set', partial),
  collabRun: (payload) => call('collab:run', payload),
  collabStop: () => call('collab:stop'),
  pingProvider: (providerId) => call('provider:ping', providerId),
  listModels: (providerId) => call('provider:listModels', providerId),
  providerBalance: (providerId) => call('provider:balance', providerId),
  getWorkdir: () => call('workdir:get'),
  pickWorkdir: () => call('workdir:pick'),
  chooseFolder: () => call('workdir:choose') /* 只挑目录，不改全局默认 */,
  workspaceScan: (dir) => call('workspace:scan', dir),
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
  appendCompact: (id, summary, upTo) => call('session:appendCompact', id, summary, upTo),
  listSkills: () => call('skills:list'),
  createSkill: (name, description) => call('skills:create', name, description),
  removeSkill: (id) => call('skills:remove', id),
  openSkillsDir: () => call('skills:openDir'),
  getMemory: () => call('memory:get'),
  setMemory: (text) => call('memory:set', text),
  clearMemory: () => call('memory:clear'),
  memoryList: (options) =>
    call('memory:list', options) /* 结构化记忆；「为什么是它」见 core/memory-explain.cjs */,
  memorySearch: (query, options) => call('memory:search', { query, ...options }),
  memoryAdd: (input) => call('memory:add', input),
  memoryUpdate: (payload) => call('memory:update', payload),
  memoryDisable: (id) => call('memory:disable', id),
  memoryEnable: (id) => call('memory:enable', id),
  memoryRemove: (id) => call('memory:remove', id),
  memoryExplain: (options) => call('memory:explain', options),
  experienceList: (options) => call('experience:list', options),
  experienceStats: () => call('experience:stats'),
  experienceReview: (payload) => call('experience:review', payload),
  searchProviders: () => call('search:providers'),
  testSearch: (override) => call('search:test', override),
  diagnosticsCopy: () => call('diagnostics:copy'),
  dataLocationGet: () => call('dataLocation:get'),
  dataLocationMigrate: (p) => call('dataLocation:migrate', p),
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
  fsList: (dir, root) => call('fs:list', dir, root),
  fsRead: (file, root) => call('fs:read', file, root),
  fsProbe: (file, root) => call('fs:probe', file, root),
  fsReveal: (target, root) => call('fs:reveal', target, root),
  fsPickAndRead: () => call('fs:pickAndRead'),
  pickImageAsDataUrl: () => call('fs:pickImageAsDataUrl'),
  attachFiles: () => call('file:attach'),
  imageSaveAs: (src) => call('image:saveAs', { src }),
  imageReveal: (src) => call('image:reveal', { src }),
  imageCopy: (src) => call('image:copy', { src }),
  projectRulesStatus: (dir) => call('projectRules:status', { dir }),
  projectRulesReload: (dir) => call('projectRules:reload', { dir }),
  projectRulesOpen: (payload) => call('projectRules:open', payload),
  projectRulesReadFile: (payload) => call('projectRules:readFile', payload),
  projectRulesWriteFile: (payload) => call('projectRules:writeFile', payload),

  shellCwd: () => call('shell:cwd'),
  shellReset: () => call('shell:reset'),
  shellRun: (payload) => call('shell:run', payload),
  shellAbort: (requestId) => call('shell:abort', requestId),

  auditList: (options) => call('audit:list', options),
  auditStats: (days) => call('audit:stats', days),
  dataPortCount: () => call('dataPort:count'),
  auditClear: () => call('audit:clear'),
  auditPrune: () => call('audit:prune'),
  errorsList: (options) => call('errors:list', options),
  riskClassify: (command) => call('risk:classify', command),
  projectsList: () => call('projects:list'),
  projectsSave: (input) => call('projects:save', input),
  projectsRemove: (id) => call('projects:remove', id),
  projectsSetActive: (id) => call('projects:setActive', id),
  taskPresets: () =>
    call('presets:list') /* ②-2：类型表来自内核（core/task-presets.cjs），前端不自己抄 */,
  networkPolicy: () => call('security:network'),
  sessionCrypto: () => call('security:sessionCrypto'),
  setSessionCrypto: (enable) => call('security:setSessionCrypto', enable),
  capabilityList: () => call('capability:list'),
  capabilityGrant: (payload) => call('capability:grant', payload),
  capabilityRevoke: (target) => call('capability:revoke', target),
  capabilityRevokeAll: () => call('capability:revokeAll'),

  taskList: (options) => call('task:list', options),
  taskUnfinished: () => call('task:unfinished'),
  taskRecovery: () => call('task:recovery'),
  taskGet: (id) => call('task:get', id),
  taskDiagnose: (id) => call('task:diagnose', id),
  taskUpdate: (payload) => call('task:update', payload),
  taskTestStatus: (options) => call('task:testStatus', options),
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
  changesetRollback: (payload) => call('changeset:rollback', payload),
  changesetRollbackTo: (payload) => call('changeset:rollbackTo', payload),
  changesetDiff: (payload) => call('changeset:diff', payload),
  artifactList: (options) => call('artifact:list', options),
  artifactGet: (id, version) => call('artifact:get', id, version),
  artifactSave: (draft) => call('artifact:save', draft),
  artifactRemove: (id) => call('artifact:remove', id),
  artifactReveal: (id) => call('artifact:reveal', id),
  schedulesList: () => call('schedules:list'),
  schedulesSave: (input) => call('schedules:save', input),
  schedulesRemove: (id) => call('schedules:remove', id),
  schedulesToggle: (id, enabled) => call('schedules:toggle', id, enabled),
  schedulesRunNow: (id) => call('schedules:runNow', id),
  downloadsList: () => call('downloads:list'),
  downloadsAdd: (payload) => call('downloads:add', payload),
  downloadsPause: (id) => call('downloads:pause', id),
  downloadsResume: (id) => call('downloads:resume', id),
  downloadsRetry: (id) => call('downloads:retry', id),
  downloadsRemove: (id) => call('downloads:remove', id),
  downloadsClear: () => call('downloads:clear'),
  downloadsSetLimits: (patch) => call('downloads:setLimits', patch),
  metricsRecent: (payload) => call('metrics:recent', payload),

  credentialsStatus: () => call('credentials:status'),
  credentialsUpgrade: () => call('credentials:upgrade'),

  ptyStart: (payload) => call('pty:start', payload),
  ptyWrite: (payload) => call('pty:write', payload),
  ptyResize: (payload) => call('pty:resize', payload),
  ptyStop: (payload) => call('pty:stop', payload),
  ptyStopAll: () => call('pty:stopAll'),
  ptyList: () => call('pty:list'),

  statsSummary: () => call('stats:summary'),
  statsReset: () => call('stats:reset'),
  usageQuery: (options) =>
    call('usage:query', options) /* 真实账本（known/unknown），见 core/usage-query.cjs */,

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
  pauseChat: (requestId) => call('chat:pause', requestId),
  confirmChat: (confirmId, approved, answer) => call('chat:confirm', confirmId, approved, answer),
  compactChat: (payload) => call('chat:compact', payload),
  onEvent: (callback) => subscribeAll(EVENTS, callback),
  onShellData: (callback) => subscribe('shell:data', callback),
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
  onPluginsChanged: (callback) => subscribe('plugins:changed', callback) /* 插件热插拔 */,
  onDownloadsEvent: (callback) => subscribe('downloads:event', callback),
  onImageDone: (callback) =>
    subscribeAll(['image:ready', 'image:failed', 'image:progress'], callback),
  onBrowserRequest: (callback) => subscribe('browser:request', callback),
  onBrowserOpenTab: (callback) => subscribe('browser:openTab', callback),
  onTaskEnd: (callback) => subscribe('app:taskEnd', callback),
  onNotificationClick: (callback) => subscribe('app:notificationClick', callback),
  browserActive: (payload) => call('browser:active', payload),
  extActiveSession: (id) => call('ext:activeSession', id),
  onExtPage: (callback) => subscribe('ext:page', callback),
  extStatus: () => call('ext:status'),
  extInstall: () => call('ext:install'),
  logAction: (entry) => report(entry),
  probeProvider: (providerId, model) => call('provider:probe', { providerId, model }),
  logError: (entry) => {
    try {
      ipcRenderer.send('log:error', entry)
    } catch {}
  },

  isElectron: true,
}
contextBridge.exposeInMainWorld('workbench', api)
