import type {
  Artifact,
  Citation,
  CodeBlock,
  DiffFile,
  MessageKind,
  MessageRole,
  MessageStatus,
  AgentPhase,
  ReasoningLevel,
  TerminalLine,
  ThreadMode,
  ThreadStatus,
} from './index'
import type { UsageBucket } from './models-extra'

/* ══════════════════════════════════════════════════════════════
   对话相关的类型：消息 / 线程级设置 / 可恢复状态 / 线程

   从 index.ts 拆出来的 —— 那边加完 Citation、Artifact、ThreadSettings、
   ConversationState 之后过了 300 行。
   ══════════════════════════════════════════════════════════════ */

export interface Message {
  id: string
  threadId: string
  role: MessageRole
  content: string
  kind: MessageKind
  status: MessageStatus
  timestamp: number
  codeBlocks?: CodeBlock[]
  diffs?: DiffFile[]
  terminalLines?: TerminalLine[]
  /** 这一轮 Agent 的细分阶段 */
  phase?: AgentPhase
  /** 模型的思考过程（真实后端模式下有值） */
  reasoning?: string
  /** 这条回复花了多少 token（服务端返回的，没有就是记不上） */
  usage?: UsageBucket
  /** 生成的图片（data URL 或 http URL），显示在消息里 */
  images?: string[]
  /** 这一轮跑过的工具（真实后端模式下有值） */
  toolRuns?: ToolRunRecord[]
  /** 可追溯的搜索/文件来源 */
  citations?: Citation[]
  /** 从回答中分离出的成果 */
  artifacts?: Artifact[]
  /** 出错时的原因，用于「重试」 */
  errorText?: string
  /** 复核过程的结构化记录 */
  review?: {
    enabled: boolean
    status: 'pending' | 'started' | 'completed' | 'failed'
    changed: boolean
    issues: string[]
  }
  /** 用户是否手动改过这条消息 */
  edited?: boolean
  /** 是否为「重新生成」产物 */
  regenerated?: boolean
  /** 父消息 id（重新生成时指向原消息） */
  parentId?: string
}

/** 一次工具调用的记录 */
export interface ToolRunRecord {
  id: string
  name: string
  /** 参数摘要，展示用 */
  summary?: string
  ok: boolean
  output: string
  ms?: number
}

export interface ThreadSettings {
  responseDepth?: 'concise' | 'standard' | 'detailed' | 'deep'
  allowNetwork?: boolean
  allowTools?: boolean
  allowWrite?: boolean
  useMemory?: boolean
  /** 思考强度（DeepSeek reasoning_effort）：low / high / max */
  reasoning?: ReasoningLevel
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

export interface Thread {
  /**
   * 这条对话的工作目录。
   * 空 = 不属于任何「对话文件夹」，用全局默认工作目录。
   */
  workdir?: string
  /**
   * 标题是不是系统自动起的。
   * true 时允许模型生成的标题把它换掉；用户手动改过就是 false，不再动。
   */
  titleAuto?: boolean
  id: string
  projectId: string
  title: string
  messages: Message[]
  status: ThreadStatus
  mode: ThreadMode
  model: string
  reasoning: ReasoningLevel
  /** 是否固定到侧栏顶部 */
  pinned: boolean
  /** 归档后从侧栏默认视图隐藏，可在「已归档」里找回 */
  archived: boolean
  /** 标签，如 bug / feature / refactor */
  tags: string[]
  /** 上次导出 Markdown 的时间戳（0 = 没导出过） */
  exportedAt: number
  createdAt: number
  updatedAt: number
  /** 独立于消息的长期对话状态 */
  conversationState?: ConversationState
  /** 临时对话：不写长期记忆 */
  temporary?: boolean
  settings?: ThreadSettings
}
