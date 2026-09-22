/* ══════════════════════════════════════════════════════════════
   会话 / 统计 / 文件 / 终端 的类型

   从 models.ts 拆出来的 —— 那边加了安全相关字段之后过 300 行了。
   ══════════════════════════════════════════════════════════════ */

export interface UsageBucket {
  prompt: number
  completion: number
  total: number
  calls: number
  /** 命中 prompt 缓存的 token 数（命中部分便宜很多） */
  cached: number
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
  /**
   * 同一段回复的身份（渲染层那条占位消息的 id）。
   *
   * 流式过程中会**分段落盘**（`partial: true`），收尾时再追加一条完整的 ——
   * 同一个 key 可能对应文件里好几行，读的一侧按它收敛成一条。老记录没有这个字段，
   * 各算各的。
   */
  key?: string
  /** 这是流式过程中的快照，不是最终结果（进程被中断时它就是你最后看到的内容） */
  partial?: boolean
  /** 读的一侧加上去的：这条只有快照、没有写完（界面据此说一句） */
  interrupted?: boolean
  /** 读的一侧加上去的：这条提问的**全部**回答（含别的版本、含重生成过的） */
  answerRecords?: StoredMessage[]
  /** 读的一侧加上去的：当前显示的是该版本回答里的第几条（0 开始） */
  answerIndex?: number
  /** 用户消息改过几版（同一条消息的多个版本，界面用 ‹ n / N › 切） */
  versions?: string[]
  /** 当前显示的是第几版（0 开始） */
  versionIndex?: number
  /** 这条回答答的是哪条提问（提问的 key）+ 第几版；读会话时按它把同一次提问的
      几个回答收成一条的多个版本（以前没有，编辑/重生成产生的回答会并排堆着） */
  answersKey?: string
  answersVersion?: number
  /** 这条接在哪条提问的哪一版后面。读会话时按当前选中的那一版筛 —— 编辑中间那条
      消息后，后面几轮（按旧内容写的）会被收起来，切回旧版本它们自己就回来 */
  parentKey?: string
  parentVersion?: number
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

/* 搜索的配置类型 —— 从 models.ts 挪过来的（那边又过 300 行了）；MCP 的已挪去 mcp.ts */

export interface SearchConfig {
  provider: string
  apiKey: string
  endpoint: string
  maxResults: number
  hasKey?: boolean
  credentialRef?: string
  citations?: boolean
}

/** 一个技能（SKILL.md）*/

/** 存到 JSONL 里的一条消息 */

/* ══════════════════════════════════════════════════════════════
   文件系统与终端（右栏）
   ══════════════════════════════════════════════════════════════ */

/** 主进程返回的目录节点（相对工作目录的 path） */

/** 终端流式输出的一块 */

/* 配置里的安全 / 上下文子类型 */
