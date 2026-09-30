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
