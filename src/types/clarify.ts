/* ══════════════════════════════════════════════════════════════
   开工前澄清（AG-053）—— 类型

   从 `types/index.ts` 拆出来的：那个文件是**公共类型的桶**，这一轮加澄清的四个类型
   就把它从 279 行推到 324（破硬约束 #2）。放这里，桶那边只留一行 re-export。

   内核侧的对应实现：`electron/core/clarify.cjs`（校验/静默/措辞）、
   `clarify-timeout.cjs`（离场超时）。
   ══════════════════════════════════════════════════════════════ */

/** 一个要用户拿主意的问题（内核规范化之后送过来的） */
export interface ClarifyQuestion {
  question: string
  options: Array<{ label: string; effect: string; concrete?: boolean }>
  allowFreeform: boolean
  /** 默认选项的 label（用户离场时按它继续） */
  defaultValue: string
  /** 'model' = 模型标的；'first' = 没标，取第一个（内核会记警告） */
  defaultFrom: 'model' | 'first'
}

/** 用户对一个问题的答复（没答的空着） */
export interface ClarifyReply {
  answers: Array<{ question: string; choice: string; text: string }>
  /** 用户点了「跳过」——不答了，让模型自己拍板 */
  skipped: boolean
}

/**
 * 「开工前问过什么」的**留存形态**（批③）—— 跟着那条助手消息一起落盘。
 *
 * 为什么要落盘：卡片答完就收了，用户过两天回看这条对话时，只会看到
 * 「模型凭空换了个包管理器」而不知道那是他当时选的。所以答案要跟着消息走，
 * 重开会话时按只读卡渲染（选项 + 他选了哪个 + 补的那句话）。
 *
 * `auto` 标的是**没人回答**的两种情况（这两条的后果不同，界面也要分开说）：
 *   · `timeout`    —— 他走开了，超时按默认选项继续（回来会收到系统通知）
 *   · `unattended` —— 定时任务，一开始就没人在场（那条对话不会弹卡）
 */
export interface StoredClarify {
  questions: ClarifyQuestion[]
  answers: ClarifyReply['answers']
  skipped: boolean
  /** 有值 = 没经过用户确认（超时 / 无人值守）；用户自己答的没有这个字段 */
  auto?: 'timeout' | 'unattended'
}
