/* ══════════════════════════════════════════════════════════════
   会话的类型（从 models-extra.ts 拆出来的）

   SessionSummary / StoredMessage / ConversationState / SessionDetail。
   拆开是因为这一组是「一条会话在磁盘上的形状」，改动理由和文件/终端那组完全不同。
   ══════════════════════════════════════════════════════════════ */

import type { UsageBucket } from './stats'
import type { StoredClarify } from './clarify'
/* 时间线片段与 UI 侧共用一份定义（type-only import，没有运行时循环） */
import type { MessageRound } from './conversation'

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
  /**
   * 一轮一轮的时间线（思考 → 工具 → 正文 的真实顺序）。
   * 不存的话重开会话会塔回三段堆叠（一大块思考 → 一列工具 → 一段正文）。
   */
  rounds?: MessageRound[]
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  ts?: number
  /** 同一段回复的身份（渲染层那条占位消息的 id）。分段快照与收尾那条共用它，读侧按它收敛成一条 */
  key?: string
  /** 这是流式过程中的快照，不是最终结果（进程被中断时它就是你最后看到的内容） */
  partial?: boolean
  /** 读的一侧加上去的：这条只有快照、没有写完（界面据此说一句） */
  interrupted?: boolean
  /** 收尾落盘时标上：这条是被用户中止的（读侧映射成 interrupted —— 按钮据此说「重试」） */
  aborted?: boolean
  /** 这条回答是「重新生成」来的：指向被替代的那条回答（磁盘 key）—— 台账对账 / 对比两次生成用 */
  regeneratedFrom?: string
  /** 读的一侧加上去的：这条提问的**全部**回答（含别的版本、含重生成过的） */
  answerRecords?: StoredMessage[]
  /** 读的一侧加上去的：当前显示的是该版本回答里的第几条（0 开始） */
  answerIndex?: number
  answerIndexByVersion?: Record<string, number> // 每个提问版本选了第几条回答（切回答的选择要落盘）
  /** 用户消息改过几版（同一条消息的多个版本，界面用 ‹ n / N › 切） */
  versions?: string[]
  /** 当前显示的是第几版（0 开始） */
  versionIndex?: number
  /** 这条回答答的是哪条提问（key）+ 第几版：读侧按它把同一次提问的多个回答收成一条 */
  answersKey?: string
  answersVersion?: number
  /** 这条接在哪条提问的哪一版后面（编辑中间那条之后，后面几轮按旧内容写的会被收起来，切回旧版本又回来） */
  parentKey?: string
  parentVersion?: number
  /** 用户带图提问：图片的 data URL。**必须落盘** —— 不存的话重开会话只剩「（图片）」那行字，画面就没了 */
  images?: string[]
  reasoning?: string
  toolCallId?: string
  toolName?: string
  /** 工具调用记录（展示用） */
  toolRuns?: Array<{ id: string; name: string; ok: boolean; output: string; ms?: number }>
  /** 开工前澄清的结果（AG-053 批③）—— 不存的话重开会话不知道那些选项是怎么定的 */
  clarify?: StoredClarify
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
