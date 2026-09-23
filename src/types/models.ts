import type {
  AuditConfig,
  ContextConfig,
  FallbackConfig,
  MemoryConfig,
  RouterConfig,
  ShellPolicy,
} from './safety'
import type { SearchConfig } from './models-extra'
import type { McpServerConfig } from './mcp'
/* 模型能力（**声明，非探测**）：下面两个字段用它；再导出一次，调用方不用改 */
import type { ModelCapabilities, ProviderCapabilityMatrix } from './model-caps'
/* 搜索 / MCP 的类型在 models-extra.ts（这里再导出一次，调用方不用改） */
export type { SearchConfig, ConversationSearchHit } from './models-extra'
/* MCP 类型搬去了 ./mcp，这里再导出一次，调用方不用改 */
export type { McpPreset, McpServerConfig, McpServerStatus } from './mcp'
export type { CapabilityDim, ModelCapabilities, ModelCapabilityInfo, ProviderCapabilityMatrix } from './model-caps'

import type { SceneMap } from './scenes'
/* ChatEvent 那两样（DiffFile / UsageBucket）跟着它搬去了 ./chat-events */

export * from './scenes'
/* ══════════════════════════════════════════════════════════════
   数据模型

   配置、会话、事件、统计、备份……所有跨进程传的形状都在这里。
   拆出这个文件是为了让 backend.ts 只管「桥上有哪些方法」。
   ══════════════════════════════════════════════════════════════ */

export type {
  UsageBucket,
  StatsSummary,
  BackupInfo,
  SkillInfo,
  SessionSummary,
  StoredMessage,
  SessionDetail,
  FsNode,
  FsTreeResult,
  FsReadResult,
  ShellData,
  ShellRunResult,
} from './models-extra'

export interface ProviderConfig {
  id: string
  name: string
  baseUrl: string
  /** 从主进程读回来时是掩码 '••••••••'；它只在写的时候有意义 */
  apiKey: string
  chatPath: string
  models: string[]
  enabled: boolean
  hasKey: boolean
  /** 密钥在凭证库里的引用名 */
  credentialRef?: string
  /** 直接 merge 进请求体的字段（优先级最高）—— 给中转站留的兜底，省得等我们改代码 */
  extraBody?: Record<string, unknown>
  /** 明确不要发的字段名（比如某些站点不认 temperature） */
  omitParams?: string[]
  /** 是否要上游在流式响应里回 usage（不认 stream_options 的站点要关掉） */
  streamUsage?: boolean
  /** DeepSeek strict 模式（Beta）：给每个 function 加 strict:true；仅 /beta 端点有效 */
  strictTools?: boolean
  /** 用户手填的能力覆盖，按模型名分组（优先于内置预设）。维度见 @/types/model-caps */
  modelCapabilities?: Record<string, Partial<ModelCapabilities>>
}

import type { CredentialsStatus } from './backend'

export interface AppConfig {
  version: number
  /** 只有内存里有：配置文件读不出来时的错误原因 —— 界面据此提示「配置损坏，已重置」 */
  _loadWarning?: string
  general: {
    theme: 'default' | 'chatgpt' | 'spec' | 'light' | 'system'
    glassmorphism: boolean
    animations: boolean
    fontScale: number
    sendOnEnter: boolean
    workdir: string
    onboarded: boolean
    onboardingDismissed: boolean
    autoTitle: boolean
    /** 点关闭时藏到托盘（桌面版） */
    minimizeToTray: boolean
  }
  providers: ProviderConfig[]
  /** 各场景用哪个模型（留空则回退到 assistant.model） */
  scenes: SceneMap
  /** 生图相关：保存目录等 */
  image: { dir: string }
  assistant: {
    name: string
    systemPrompt: string
    model: string
    temperature: number
    topP: number
    maxTokens: number
    historyLimit: number
    responseDepth: 'concise' | 'standard' | 'detailed' | 'deep'
    selfReview: boolean
    streamOutput: boolean
  }
  tools: {
    permission: 'full' | 'ask' | 'readonly'
    shellTimeout: number
    /** 文件访问范围：默认只给工作目录 */
    fileScope: 'workspace' | 'granted' | 'full'
    /** 各风险等级怎么处置 */
    shellPolicy: ShellPolicy
    /** 单次工具输出上限（字节） */
    outputLimit: number
  }
  search: SearchConfig
  mcp: { servers: McpServerConfig[] }
  /** 结构化记忆的写入与检索策略 */
  memory: MemoryConfig
  /** 上下文预算与压缩阈值 */
  context: ContextConfig
  /** 模型路由：不同活派不同模型 */
  router: RouterConfig
  /** 失败重试与降级 */
  fallback: FallbackConfig
  /** 工具调用审计 */
  audit: AuditConfig
  /** 用量闸：按 token 数设日/月上限（0 = 不限）。详见 electron/core/limits.cjs */
  limits: {
    enabled: boolean
    dailyTokens: number
    monthlyTokens: number
    onExceed: 'block' | 'warn'
  }
  updatedAt: number
  /** 凭证库状态（主进程附带的，只读） */
  credentials?: CredentialsStatus
  /** 模型能力矩阵（主进程附带的，只读）。是**声明**不是探测，详见 @/types/model-caps */
  capabilities?: ProviderCapabilityMatrix
  brand?: { id: string; name: string; assistant: string; namespace: string; envFlag: string }
}

/** 主进程 cfg 里有的字段，映射到界面设置里对应的键 */
export type ConfigBackedSettings = Pick<
  AppConfig['general'],
  'theme' | 'glassmorphism' | 'animations' | 'fontScale' | 'sendOnEnter'
>

/** 路径审计：数据目录是否都在 C 盘之外（自检用）。别和「工具调用审计」混了 */
export interface PathAuditEntry {
  label: string
  dir: string
  ok: boolean
}

export interface SelfTestReport {
  ok: boolean
  version: string
  electron: string
  node: string
  dataDir: string
  workdir: string
  audits: PathAuditEntry[]
  config: AppConfig
}

/*
 * ChatEvent 搬去了 `./chat-events`（这个文件 315 行贴了上限，而那一整块
 * 本来就是「一次对话推给界面的所有事件」，是个完整的东西）。
 * 保留这行转发，是因为调用方全写 `@/types/models` —— 别去改它们。
 */
export type { ChatEvent } from './chat-events'

/** 发出去的消息：带图时 content 是数组（多模态），否则是字符串 */
export interface ChatSendPayload {
  requestId: string
  /** AG-003：用户按下发送的时刻（渲染层带过来，主进程据此算 TTFT 等） */
  requestTime?: number
  mode?: string
  model?: string
  /** 这条会话自己的工作目录（不传就用全局默认） */
  workdir?: string
  /** 会话 id：审计、路径授权、任务台账都靠它串起来 */
  sessionId?: string
  /** AG-011：接着哪条暂停的任务做 —— 主进程会**复用那条任务**，不新建 */
  resumeTaskId?: string
  projectId?: string
  temporary?: boolean
  threadSettings?: {
    responseDepth?: 'concise' | 'standard' | 'detailed' | 'deep'
    allowNetwork?: boolean
    allowTools?: boolean
    allowWrite?: boolean
    useMemory?: boolean
    /** 思考强度（DeepSeek reasoning_effort）：low / high / max */
    reasoning?: 'low' | 'high' | 'max'
  }
  messages: Array<{
    role: string
    content: string | Array<Record<string, unknown>>
    tool_calls?: unknown[]
  }>
}
export type {
  RiskLevel,
  PolicyAction,
  ShellPolicy,
  MemoryConfig,
  ContextConfig,
  RouterConfig,
  FallbackConfig,
  AuditConfig,
} from './safety'
