import type {
  AuditConfig,
  ContextConfig,
  FallbackConfig,
  MemoryConfig,
  RouterConfig,
  ShellPolicy,
} from './safety'
import type { SearchConfig, McpServerConfig } from './models-extra'
/* 搜索 / MCP 的类型在 models-extra.ts（这里再导出一次，调用方不用改） */
export type { SearchConfig, McpServerConfig, McpServerStatus } from './models-extra'

import type { SceneMap } from './scenes'
/* ChatEvent 里用到；转发给外部看是下面那个 export type 块的事 */
import type { UsageBucket } from './models-extra'

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
  /**
   * 直接 merge 进请求体的字段（优先级最高）。
   * 给中转站/怪站点留的兜底，省的等我们改代码。
   */
  extraBody?: Record<string, unknown>
  /** 明确不要发的字段名（比如某些站点不认 temperature） */
  omitParams?: string[]
  /** 是否要上游在流式响应里回 usage（不认 stream_options 的站点要关掉） */
  streamUsage?: boolean
  /** DeepSeek strict 模式（Beta）：给每个 function 加 strict:true；仅 /beta 端点有效 */
  strictTools?: boolean
}

import type { CredentialsStatus } from './backend'

export interface AppConfig {
  version: number
  /**
   * 只有内存里有：配置文件读不出来时的错误原因（主进程填）。
   * 界面据此提示「配置损坏，已重置」—— 不然用户只会发现设置莫名其妙没了。
   */
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

export type ChatEvent =
  | { requestId: string; type: 'mode'; mode: string; confidence: number; reason: string }
  | {
      requestId: string
      type: 'route'
      role: string
      model: string
      provider: string
      reason: string
    }
  | { requestId: string; type: 'turn_start'; turn: number }
  /* AG-004：模型给了新的一版计划（和上一版一样就不发） */
  | { requestId: string; type: 'plan'; plan: string[]; version: number; reason: string }
  | { requestId: string; type: 'turn_end'; turn: number; usage: Record<string, number> | null }
  | { requestId: string; type: 'content'; text: string }
  | { requestId: string; type: 'reasoning'; text: string }
  | {
      requestId: string
      type: 'agent.tool.started'
      toolCallId: string
      name: string
      args: Record<string, unknown>
    }
  | {
      requestId: string
      /* AG-002：成败写在事件名里，前端不用再读 ok；服务端仍会带 ok，两者一致 */
      type: 'agent.tool.completed' | 'agent.tool.failed'
      toolCallId: string
      name: string
      ok: boolean
      result: string
      ms?: number
    }
  | {
      requestId: string
      type: 'confirm_request'
      confirmId: string
      toolName: string
      summary: string
      args: Record<string, unknown>
    }
  | {
      requestId: string
      type: 'done'
      content: string
      reasoning: string
      usage: UsageBucket | null
      turns: number
      exhausted: boolean
    }
  | { requestId: string; type: 'aborted' }
  | { requestId: string; type: 'review'; status: 'started' | 'completed' }
  | {
      requestId: string
      type: 'budget'
      exceeded: boolean
      blocked: boolean
      level: 'day' | 'month' | null
      used: number
      limit: number
      message: string
    }
  | { requestId: string; type: 'error'; message: string }
  /* AG-001 + AG-002：生命周期事件。状态机每次转移推一条，事件名用标准名，
     **每条都带 phase** —— 前端只读 phase、不解析事件名，将来改名不影响渲染层。
     executing / responding 没有标准名，用 'phase' 发（它们是执行细节）。 */
  | {
      requestId: string
      type:
        | 'phase'
        | 'agent.started'
        | 'agent.thinking'
        | 'agent.planning'
        | 'agent.verification.started'
        | 'agent.verification.completed'
        | 'agent.waiting_user'
        | 'agent.paused'
        | 'agent.resumed'
        | 'agent.retrying'
        | 'agent.completed'
        | 'agent.failed'
        | 'agent.cancelled'
      /** 相位名（和主进程 lifecycle.cjs 的 13 个状态一致） */
      phase: string
      from: string
      detail?: string
    }

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

export interface ConversationSearchHit {
  threadId: string
  title: string
  workdir?: string
  timestamp: number
  role: string
  snippet: string
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
