/* ══════════════════════════════════════════════════════════════
   会话的类型（从 models-extra.ts 拆出来的）

   SessionSummary / StoredMessage / ConversationState / SessionDetail。
   拆开是因为这一组是「一条会话在磁盘上的形状」，改动理由和文件/终端那组完全不同。
   ══════════════════════════════════════════════════════════════ */

import type { MessageUsage } from './usage'
import type { StoredClarify } from './clarify'
import type { ExecVerdict } from './verdict'
/* 时间线片段与 UI 侧共用一份定义（type-only import，没有运行时循环） */
import type { MessageRound, Thread } from './conversation'

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
  collab?: Thread['collab']
  parentThreadId?: string
  branchPointMessageId?: string
  messageCount: number
  createdAt: number
  updatedAt: number
}

export interface StoredMessage {
  collaboration?: import('./collaboration').CollaborationRecord
  inputReplies?: import('./inputReply').StoredInputReply[]
  /** 这条回复的 token 用量（跟着落盘，重开会话也能算总量；`known:false` = 当时没上报） */
  usage?: MessageUsage
  /**
   * 一轮一轮的时间线（思考 → 工具 → 正文 的真实顺序）。
   * 不存的话重开会话会塔回三段堆叠（一大块思考 → 一列工具 → 一段正文）。
   */
  rounds?: MessageRound[]
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  ts?: number
  /**
   * 这条不是用户手打的，是谁送进来的（2026-11-04）。
   *
   * 目前只有 `'extension'`：浏览器扩展读到的网页 / 页面操作回执，由
   * `electron/core/ext-ops.cjs` 的 `ingest()` 落成 `role: 'user'`。
   * 它**必须**带着这个字段走出磁盘 —— 界面靠它把「已读取网页」折成一行，
   * 而不是画成用户气泡（以前读侧不带它，主窗口和侧边栏都画成一串用户消息）。
   */
  source?: string
  /** 同一段回复的身份（渲染层那条占位消息的 id）。分段快照与收尾那条共用它，读侧按它收敛成一条 */
  key?: string
  /** 这是流式过程中的快照，不是最终结果（进程被中断时它就是你最后看到的内容） */
  partial?: boolean
  /** 读的一侧加上去的：这条只有快照、没有写完（界面据此说一句） */
  interrupted?: boolean
  /** 收尾落盘时标上：这条是被用户中止的（读侧映射成 interrupted —— 按钮据此说「重试」） */
  aborted?: boolean
  /**
   * 上游说的「没写完」（2026-11-08）：`length` = 撞输出上限，`stream_cut` = 断流。
   * 与 `interrupted` 的区别：那个是**磁盘上只剩快照**推断出来的，这个是**上游亲口说的**。
   */
  truncated?: 'length' | 'stream_cut' | ''
  /**
   * 这一轮实际花了多少毫秒（2026-10-21）。
   *
   * 起止点口径写在 `src/types/conversation.ts` 的 `Message.durationMs` 注释里。
   * 老记录没有这个字段 → 界面显示「N 步」不显示秒数，不推算。
   */
  durationMs?: number
  /** 这条回答是「重新生成」来的：指向被替代的那条回答（磁盘 key）—— 台账对账 / 对比两次生成用 */
  regeneratedFrom?: string
  /** 这次的验收结论（`done`/`partial`/`failed`/`chat`）—— 与答复正文分开存，口径见 `types/verdict.ts` */
  verdict?: ExecVerdict
  /**
   * 这次执行的身份（= 发送时的 requestId，2026-11-09）。
   *
   * 一次发送 / 继续 / 重新生成各有一个 —— 重启后靠它区分「这三次是不同的执行」。
   * 老记录没有这个字段 → 界面照旧显示，不回填、不按会话去猜。
   */
  execId?: string
  /**
   * 这次执行归属的任务（继续原任务时 = 原 taskId）。
   *
   * ★ 没有就**不写**。不拿「会话最近一个任务」来顶替 —— 那会把两条不相干的
   * 执行挂到同一个任务上，比留空更难查。
   */
  execTaskId?: string
  /**
   * 这条记录的轨迹格式（2026-11-09）。
   *
   * `'ordered-v1'` = `rounds` 是**执行时按事件到达顺序攒下来的**（逐轮记
   * 「思考 / 工具下标 / 正文」），因此能原样还原「正文 A → 工具 → 正文 B」。
   *
   * 老记录没有这个字段 —— 它们的 `rounds` 要么不存在，要么是读侧由三段
   * （reasoning / toolRuns / content）**合成**的一轮。合成的那个「顺序」是猜的，
   * 回放必须走兼容路径，不能当真实轨迹渲染。
   */
  flow?: import('../lib/conversationFlow').ConversationFlow
  trace?: 'ordered-v1'
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
  toolRuns?: import('./rounds').ToolRunRecord[]
  /** 开工前澄清的结果（AG-053 批③）—— 不存的话重开会话不知道那些选项是怎么定的 */
  clarify?: StoredClarify
  citations?: import('./deliverables').Citation[]
  artifacts?: import('./deliverables').Artifact[]
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
    collab?: Thread['collab']
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
