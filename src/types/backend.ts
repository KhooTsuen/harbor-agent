/* window.workbench 的声明。Electron 下有真实文件/终端/模型，浏览器预览下只有 UI。 所有 IPC 都返回 { ok, ... }，失败不扔异常 —— 跨进程扔了也拿不到栈。 */

import type {
  AppConfig,
  BackupInfo,
  ChatEvent,
  ChatSendPayload,
  McpServerStatus,
  McpPreset,
  SearchConfig,
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
import type { ImageDonePayload } from './image'
import type { ErrorsBridge } from './errors'
import type { NotifyBridge } from './notify'
import type { WorkspaceBridge } from './workspace'
import type { BrowserBridge } from './browser'
import type { IoBridge } from './backend-io'
export * from './models'
/* 浏览器工具的桥在 browser.ts，这里转出去：老引用路径还是 '@/types/backend' */
export * from './browser'
/* SafetyBridge 已带上 ProfileBridge，这里不重复列；ErrorsBridge = 右栏「错误」标签 */

/**
 * 能力探测的**实测**结果（内核 `model-probe.cjs`）。
 *
 * `results` 里每项是 `true` / `false` / `null`：**`null` = 没测出来，不等于不支持**。
 * 界面上这两者画得不一样 —— 把未知画成不支持等于替用户猜了。
 */
export interface ModelProbeResult {
  ok: boolean
  at: number
  providerId: string
  model: string
  results: Partial<
    Record<'connection' | 'streaming' | 'tool_call' | 'vision' | 'usage' | 'listed', boolean | null>
  >
  /** 为什么这么判（人话，给用户看的那句） */
  notes: Record<string, string>
  error?: string
}

export interface WorkbenchBridge
  extends SafetyBridge, NotifyBridge, WorkspaceBridge, ErrorsBridge, BrowserBridge, IoBridge {
  selfTest: () => Promise<SelfTestReport>
  quitApp: () => Promise<void>
  showWindow: () => Promise<{ ok: boolean }>
  setTitleBar: (colors: { color: string; symbolColor: string }) => Promise<{ ok: boolean }>
  getConfig: () => Promise<AppConfig>
  patchConfig: (partial: Record<string, unknown>) => Promise<{ ok: boolean; config: AppConfig }>
  resetConfig: () => Promise<{ ok: boolean; config: AppConfig }>
  pingProvider: (providerId?: string) => Promise<{ ok: boolean; model?: string; error?: string }>
  listModels: (providerId?: string) => Promise<{ ok: boolean; models?: string[]; error?: string }>
  /* 能力探测：**实测**一个模型会什么（只回实测；声明在 config.capabilities，界面两边并排看） */
  probeProvider?: (providerId: string, model: string) => Promise<ModelProbeResult>
  getWorkdir: () => Promise<string>
  pickWorkdir: () => Promise<{ ok: boolean; workdir?: string; canceled?: boolean }>
  chooseFolder: () => Promise<{ ok: boolean; dir?: string; canceled?: boolean }>
  sendChat: (
    payload: ChatSendPayload,
  ) => Promise<{ ok: boolean; requestId?: string; error?: string }>
  abortChat: (requestId: string) => Promise<{ ok: boolean; error?: string }>
  /* AG-011：暂停 —— 做完当前这步再停，和 abort（立刻断）不是一回事 */
  pauseChat: (requestId: string) => Promise<{ ok: boolean; error?: string }>
  confirmChat: (
    confirmId: string,
    approved: boolean,
    answer?: string,
  ) => Promise<{ ok: boolean; error?: string }>
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
    reasoning?: string
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
      reasoning?: string
      threadSettings?: Record<string, unknown>
    },
  ) => Promise<{ id: string; title: string } | null>
  removeSession: (id: string) => Promise<{ ok: boolean }>
  removeAllSessions: () => Promise<{ ok: boolean; count: number }>
  sessionToApiMessages: (
    id: string,
    limit?: number,
  ) => Promise<Array<{ role: string; content: string }>>

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
  mcpPresets: () => Promise<McpPreset[]>
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

  onEvent: (callback: (event: ChatEvent) => void) => () => void

  onPluginsChanged: (
    callback: (change: { added: string[]; removed: string[]; count: number }) => void,
  ) => () => void

  /** 生图完成 / 失败（异步任务，可能几分钟后才回来） */
  onImageDone: (callback: (payload: ImageDonePayload) => void) => () => void

  isElectron: true
}

declare global {
  interface Window {
    workbench?: WorkbenchBridge
  }
}
/* 安全 / 可靠相关（审计、授权、任务、改动事务、凭证、记忆）*/
export * from './safety'
