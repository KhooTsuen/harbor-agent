/* ══════════════════════════════════════════════════════════════
   window.workbench 的声明

   渲染层有两种运行环境：
     · Electron  → 桥存在，使用真实文件、终端、模型和磁盘配置
     · 浏览器    → 没有桌面桥，仅用于 UI 预览

   所有 IPC 调用都返回 { ok, ... } 形状，失败不扔异常
   （跨进程扔了也拿不到栈）。
   ══════════════════════════════════════════════════════════════ */

import type {
  AppConfig,
  BackupInfo,
  FsReadResult,
  FsTreeResult,
  ChatEvent,
  ChatSendPayload,
  McpServerStatus,
  SearchConfig,
  ShellData,
  ShellRunResult,
  SelfTestReport,
  SessionDetail,
  SessionSummary,
  ConversationSearchHit,
  SceneStatus,
  StoredMessage,
  SkillInfo,
  StatsSummary,
} from './models'

import type { MemoryStats, SafetyBridge } from './safety'

export * from './models'

export interface WorkbenchBridge extends SafetyBridge {
  selfTest: () => Promise<SelfTestReport>
  quitApp: () => Promise<void>
  showWindow: () => Promise<{ ok: boolean }>
  getConfig: () => Promise<AppConfig>
  patchConfig: (partial: Record<string, unknown>) => Promise<{ ok: boolean; config: AppConfig }>
  resetConfig: () => Promise<{ ok: boolean; config: AppConfig }>
  pingProvider: (providerId?: string) => Promise<{ ok: boolean; model?: string; error?: string }>
  listModels: (providerId?: string) => Promise<{ ok: boolean; models?: string[]; error?: string }>
  getWorkdir: () => Promise<string>
  pickWorkdir: () => Promise<{ ok: boolean; workdir?: string; canceled?: boolean }>
  /** 只挑目录，不改全局工作目录（给单条对话挂目录用） */
  chooseFolder: () => Promise<{ ok: boolean; dir?: string; canceled?: boolean }>
  sendChat: (
    payload: ChatSendPayload,
  ) => Promise<{ ok: boolean; requestId?: string; error?: string }>
  abortChat: (requestId: string) => Promise<{ ok: boolean; error?: string }>
  confirmChat: (confirmId: string, approved: boolean) => Promise<{ ok: boolean; error?: string }>
  compactChat: (payload: {
    model?: string
    messages: Array<{ role: string; content: string }>
  }) => Promise<{ ok: boolean; summary?: string; error?: string }>

  listSessions: () => Promise<SessionSummary[]>
  searchSessions: (query: string, limit?: number) => Promise<ConversationSearchHit[]>
  listWorkdirs: () => Promise<Array<{ workdir: string; count: number; lastUsedAt: number }>>
  createSession: (options?: {
    title?: string
    mode?: string
    model?: string
    /** 这条会话的工作目录；'' = 明确不属于任何文件夹（单独对话） */
    workdir?: string
    threadSettings?: Record<string, unknown>
  }) => Promise<{ id: string; title: string; mode: string; model: string; createdAt: number }>
  loadSession: (id: string) => Promise<SessionDetail | null>
  appendMessage: (id: string, message: StoredMessage) => Promise<{ ok: boolean }>
  updateSessionMeta: (
    id: string,
    patch: {
      title?: string
      mode?: string
      model?: string
      workdir?: string
      threadSettings?: Record<string, unknown>
    },
  ) => Promise<{ id: string; title: string } | null>
  removeSession: (id: string) => Promise<{ ok: boolean }>
  removeAllSessions: () => Promise<{ ok: boolean; count: number }>
  sessionToApiMessages: (
    id: string,
    limit?: number,
  ) => Promise<Array<{ role: string; content: string }>>

  saveText: (payload: {
    defaultName: string
    content: string
  }) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>

  pickJson: () => Promise<{
    ok: boolean
    content?: string
    path?: string
    canceled?: boolean
    error?: string
  }>
  importSessions: (list: unknown[]) => Promise<unknown[]>
  appendCompact: (
    id: string,
    summary: string,
    upTo: number,
  ) => Promise<{ ok: boolean; error?: string }>

  listSkills: () => Promise<SkillInfo[]>
  createSkill: (
    name: string,
    description: string,
  ) => Promise<{ ok: boolean; id?: string; path?: string; error?: string }>
  removeSkill: (id: string) => Promise<{ ok: boolean; error?: string }>
  openSkillsDir: () => Promise<{ ok: boolean; dir: string }>

  /* 老的纯文本记忆接口（整段读写），结构化接口在 SafetyBridge 里 */
  getMemory: () => Promise<{ text: string; stats: MemoryStats; path: string }>
  setMemory: (text: string) => Promise<{ ok: boolean; stats?: MemoryStats; error?: string }>
  clearMemory: () => Promise<{ ok: boolean; stats: MemoryStats }>

  searchProviders: () => Promise<Array<{ id: string; label: string; needKey: boolean }>>
  testSearch: (override?: Partial<SearchConfig>) => Promise<{
    ok: boolean
    count?: number
    sample?: string
    error?: string
  }>

  statsSummary: () => Promise<StatsSummary>
  statsReset: () => Promise<{ ok: boolean; summary: StatsSummary }>

  backupList: () => Promise<BackupInfo[]>
  backupCreate: () => Promise<{ ok: boolean; name?: string; error?: string; items?: string[] }>
  backupRestore: (name: string) => Promise<{
    ok: boolean
    restored?: string[]
    safetyBackup?: string
    needsRestart?: boolean
    error?: string
  }>
  backupRemove: (name: string) => Promise<{ ok: boolean; error?: string }>
  backupOpen: () => Promise<{ ok: boolean; path?: string; error?: string }>

  mcpStatus: () => Promise<McpServerStatus[]>
  mcpRestart: () => Promise<{ ok: boolean; servers: McpServerStatus[] }>

  diagnosticsCopy: () => Promise<{
    ok: boolean
    chars?: number
    errorCount?: number
    logLines?: number
    error?: string
  }>
  diagnosticsSave: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
  diagnosticsOpenDir: () => Promise<{ ok: boolean }>

  sceneSnapshot: () => Promise<{
    scenes: SceneStatus[]
    providers: Array<{
      providerId: string
      providerName: string
      enabled: boolean
      models: string[]
    }>
  }>
  sceneTitle: (messages: Array<{ role: string; content: string }>) => Promise<{
    ok: boolean
    title?: string
    error?: string
  }>
  sceneOptimize: (text: string) => Promise<{ ok: boolean; text?: string; error?: string }>
  sceneTranslate: (text: string) => Promise<{
    ok: boolean
    text?: string
    target?: string
    error?: string
  }>
  sceneSuggest: (messages: Array<{ role: string; content: string }>) => Promise<{
    ok: boolean
    suggestions?: string[]
    error?: string
  }>
  sceneOcr: (imageDataUrl: string) => Promise<{ ok: boolean; text?: string; error?: string }>
  sceneImage: (
    prompt: string,
    size?: string,
  ) => Promise<{ ok: boolean; image?: string; model?: string; error?: string }>

  fsWorkdir: () => Promise<{ workdir: string; exists: boolean }>
  fsTree: (dir?: string) => Promise<FsTreeResult>
  fsList: (
    dir: string,
  ) => Promise<{ ok: boolean; items?: Array<{ name: string; type: string }>; error?: string }>
  fsRead: (file: string) => Promise<FsReadResult>
  fsReveal: (target: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  pickImageAsDataUrl: () => Promise<{
    ok: boolean
    canceled?: boolean
    dataUrl?: string
    name?: string
    error?: string
  }>
  fsPickAndRead: () => Promise<{
    ok: boolean
    canceled?: boolean
    name?: string
    path?: string
    text?: string
    size?: number
    error?: string
  }>

  shellCwd: () => Promise<{ cwd: string }>
  shellReset: () => Promise<{ cwd: string }>
  shellRun: (payload: {
    command: string
    requestId: string
    timeout?: number
  }) => Promise<ShellRunResult>
  shellAbort: (requestId: string) => Promise<{ ok: boolean; error?: string }>
  onShellData: (callback: (data: ShellData) => void) => () => void

  /* ── 真终端（PTY）────────────────────────────────────── */

  ptyStart: (payload: { id: string; cols?: number; rows?: number; cwd?: string }) => Promise<{
    ok: boolean
    id?: string
    shell?: string
    pid?: number
    cols?: number
    rows?: number
    error?: string
  }>
  ptyWrite: (payload: { id: string; data: string }) => Promise<{ ok: boolean; error?: string }>
  ptyResize: (payload: {
    id: string
    cols: number
    rows: number
  }) => Promise<{ ok: boolean; error?: string }>
  ptyStop: (payload: { id: string }) => Promise<{ ok: boolean }>
  ptyStopAll: () => Promise<{ ok: boolean; closed?: number }>
  ptyList: () => Promise<{
    ok: boolean
    sessions: Array<{ id: string; pid: number; cols: number; rows: number; startedAt: number }>
  }>
  /** 终端输出分片与退出事件走同一个回调，type 区分 */
  onPtyEvent: (
    callback: (
      event:
        | { type: 'data'; id: string; chunk: string }
        | { type: 'exit'; id: string; exitCode: number },
    ) => void,
  ) => () => void

  onEvent: (callback: (event: ChatEvent) => void) => () => void

  /** 插件热插拔：新增/删除插件时主进程通知 */
  onPluginsChanged: (
    callback: (change: { added: string[]; removed: string[]; count: number }) => void,
  ) => () => void

  /* ── 浏览器：主进程的 browse 工具请求渲染层操作 webview ── */
  onBrowserRequest: (callback: (request: BrowserRequestEvent) => void) => () => void
  browserResult: (
    id: string,
    result: {
      ok: boolean
      text?: string
      html?: string
      title?: string
      url?: string
      error?: string
    },
  ) => Promise<{ ok: boolean; error?: string }>

  isElectron: true
}

/** 主进程发来的一次浏览请求 */
export interface BrowserRequestEvent {
  id: string
  action: string
  url?: string
}

declare global {
  interface Window {
    workbench?: WorkbenchBridge
  }
}

/* ══════════════════════════════════════════════════════════════
   安全 / 可靠相关的形状
   ══════════════════════════════════════════════════════════════ */

/* 安全 / 可靠相关（审计、授权、任务、改动事务、凭证、记忆）*/
export * from './safety'
