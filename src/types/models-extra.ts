/* ══════════════════════════════════════════════════════════════
   会话 / 统计 / 文件 / 终端 的类型

   从 models.ts 拆出来的 —— 那边加了安全相关字段之后过 300 行了。
   ══════════════════════════════════════════════════════════════ */

export interface UsageBucket {
  prompt: number
  completion: number
  total: number
  calls: number
}

export interface StatsSummary {
  since: number
  total: UsageBucket
  days: Array<UsageBucket & { day: string }>
  models: Array<UsageBucket & { model: string }>
  file: string
}

export interface BackupInfo {
  name: string
  path: string
  size: number
  reason: string
  items: string[]
  createdAt: number
}

export interface SkillInfo {
  /** 目录名 */
  id: string
  name: string
  description: string
  /** 正文长度，0 表示空壳 */
  bodyLength: number
  path: string
  dir: string
  updatedAt: number
}

export interface ConversationSearchHit {
  threadId: string
  title: string
  workdir?: string
  timestamp: number
  role: string
  snippet: string
}

interface ProjectSkillInfo {
  id: string
  name: string
  description: string
  path: string
  bodyLength: number
  updatedAt: number
}

export interface ProjectContextData {
  ok: boolean
  workdir: string
  instructionFile: string
  instructions: string
  skills: ProjectSkillInfo[]
  error?: string
}

export interface ArtifactRecord {
  id: string
  type: 'document' | 'code' | 'patch' | 'report' | 'generated_file'
  name: string
  path?: string
  content?: string
  version: number
  threadId?: string
  taskId?: string
  sourceMessageId?: string
  createdAt: number
  updatedAt: number
  versions: Array<{ version: number; content?: string; path?: string; createdAt: number }>
}

export interface ArtifactListResult {
  ok: boolean
  artifacts: ArtifactRecord[]
  error?: string
}

export interface ConversationStateHistory {
  version: number
  state: ConversationState
  createdAt: number
}

export interface SessionSummary {
  id: string
  title: string
  mode: string
  model: string
  workdir?: string
  temporary?: boolean
  threadSettings?: {
    responseDepth?: 'concise' | 'standard' | 'detailed' | 'deep'
    allowNetwork?: boolean
    allowTools?: boolean
    allowWrite?: boolean
    useMemory?: boolean
  }
  parentThreadId?: string
  branchPointMessageId?: string
  messageCount: number
  createdAt: number
  updatedAt: number
}

export interface StoredMessage {
  /** 这条回复的 token 用量（跟着落盘，重开会话也能算总量） */
  usage?: UsageBucket
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  ts?: number
  reasoning?: string
  toolCallId?: string
  toolName?: string
  /** 工具调用记录（展示用） */
  toolRuns?: Array<{ id: string; name: string; ok: boolean; output: string; ms?: number }>
  citations?: Array<{
    id: string
    kind: 'web' | 'file'
    title: string
    url?: string
    path?: string
    startLine?: number
    endLine?: number
    domain?: string
    snippet?: string
    fetchedAt?: number
  }>
  artifacts?: Array<{
    id: string
    type: 'document' | 'code' | 'patch' | 'report' | 'generated_file'
    name: string
    path?: string
    content?: string
    version?: number
    threadId?: string
    taskId?: string
    sourceMessageId?: string
    createdAt: number
    updatedAt?: number
    versions?: Array<{ version: number; content?: string; path?: string; createdAt: number }>
  }>
  error?: string
}

export interface ConversationState {
  topic: string
  goal: string
  currentFocus: string
  entities: string[]
  decisions: string[]
  constraints: string[]
  openQuestions: string[]
  nextStep: string
  lastUpdated: string
  version: number
}

export interface SessionDetail {
  meta: {
    type: 'meta'
    id: string
    title: string
    mode: string
    model: string
    createdAt: number
    temporary?: boolean
    parentThreadId?: string
    branchPointMessageId?: string
    threadSettings?: {
      responseDepth?: 'concise' | 'standard' | 'detailed' | 'deep'
      allowNetwork?: boolean
      allowTools?: boolean
      allowWrite?: boolean
      useMemory?: boolean
    }
  }
  messages: StoredMessage[]
  /** 压缩点（可能为空数组） */
  compacts?: Array<{ summary: string; upTo: number; ts: number }>
  state?: ConversationState | null
  threadSettings?: {
    responseDepth?: 'concise' | 'standard' | 'detailed' | 'deep'
    allowNetwork?: boolean
    allowTools?: boolean
    allowWrite?: boolean
    useMemory?: boolean
  }
}

export interface FsNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  children?: FsNode[]
}

export interface FsTreeResult {
  ok: boolean
  root: string
  name: string
  children: FsNode[]
  truncated: boolean
  error?: string
}

export interface FsReadResult {
  ok: boolean
  binary?: boolean
  text?: string
  size?: number
  path?: string
  ext?: string
  error?: string
}

export interface ShellData {
  requestId: string
  stream: 'stdout' | 'stderr'
  text: string
}

export interface ShellRunResult {
  ok: boolean
  requestId: string
  code?: number
  output?: string
  cwd?: string
  error?: string
}
