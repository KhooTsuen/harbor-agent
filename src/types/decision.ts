/* ══════════════════════════════════════════════════════════════
   决策（Decision）—— 主进程 `electron/core/decisions.cjs` 的 TS 镜像（P0-5 收敛）

   一条「要用户拿主意」的往返只有**一条通道**（`chat:confirm`）、**一个事件名**
   （`confirm_request`），靠 `decisionType` 区分是审批还是澄清 —— 不再靠 `kind` 猜
   （审批的 `kind` 是工具种类 write/mcp/…，澄清的 `kind` 恒为 'clarify'，同名字段
   两套值域）。

   两侧的类型集合必须一致（硬约束 9：跨模块约定一处真相源）：
   `125-decision-shape` 自检从两边源码把集合抠出来、断言相等 —— 谁改了忘同步就报红。

   ⚠️ 改这里 = 改主进程那份，两处一起改。
   ══════════════════════════════════════════════════════════════ */

/** 决策类型（与 `electron/core/decisions.cjs` 的 `DECISION_TYPES` 一一对应） */
export const DECISION_TYPES = ['approval', 'clarify'] as const

export type DecisionType = (typeof DECISION_TYPES)[number]
