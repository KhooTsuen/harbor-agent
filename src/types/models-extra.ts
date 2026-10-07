/* ══════════════════════════════════════════════════════════════
   备份 / 技能 / 项目 / 产物 / 文件 / 终端 的类型

   从 models.ts 拆出来的 —— 那边加了安全相关字段之后过 300 行了。
   会话那一组（SessionSummary / StoredMessage …）又拆去了 `./models-session`，这里再导出一次，
   从这儿 import 的调用方不用改。
   用量统计那一组（桶 + 闸门状态）在 `./stats`，同样转出去。
   ══════════════════════════════════════════════════════════════ */

export type { LimitsGateState, StatsSummary, UsageBucket } from './stats'
export * from './models-session'

export interface BackupInfo {
  name: string
  path: string
  size: number
  reason: string
  items: string[]
  createdAt: number
  /** 空壳：一个用户项都没有（界面据此禁用「恢复」）；missing = 缺哪几项（按磁盘现算） */
  empty: boolean
  missing: string[]
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
