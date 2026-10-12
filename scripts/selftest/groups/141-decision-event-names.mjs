import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   决策卡事件名：一处真值（event-types.cjs） ↔ 使用处（decisions.cjs）

   为什么单列（审计 §3.5，2026-10-13 收敛）：
     · 以前 `decisions.cjs` 各写一份字面量（`confirm_request` / `confirm.timeout` /
       `clarify.timeout`），与 `event-types.cjs` 的 `CHAT_EVENT_TYPES` 逐字重复。
     · 自检 126 **扫不到它**：126 只抠 `emit({ type: '…' })` 的**字面量**，而
       `chat-confirm.cjs` 发的是 `emit({ type: decisions.CONFIRM_REQUEST })` 这种**变量**。
   收敛后：真值在 `event-types.cjs` 的 `DECISION_EVENTS`，`decisions.cjs` require 取用。

   这一组钉三件（硬约束 9）：
     ① 真值 ∈ 清单：`DECISION_EVENTS` 的每个值都在 `CHAT_EVENT_TYPES` 里；
     ② 使用处对齐：`decisions.cjs` **真跑**出来的事件名 === `DECISION_EVENTS` 的值；
     ③ 不许各写一套：`decisions.cjs` 源码里**不再出现**那 3 个字面量（有人写回去就报红）。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  group('P0-5 / 决策卡事件名：一处真值（decisions.cjs 不许再各写一份字面量）')

  const eventTypes = require(join(ROOT, 'electron/core/event-types.cjs'))
  const decisions = require(join(ROOT, 'electron/core/decisions.cjs'))

  const EV = eventTypes.DECISION_EVENTS ?? {}
  const listed = new Set(eventTypes.CHAT_EVENT_TYPES ?? [])
  const values = Object.values(EV)

  check('★ DECISION_EVENTS 有 3 个名字', values.length === 3, values.join(',') || 'no-value')

  /* ① 真值 ∈ 清单（清单必须覆盖它们，否则「发出点 ⊆ 清单」漏了） */
  for (const v of values) check(`★ 真值「${v}」登记在 CHAT_EVENT_TYPES 里`, listed.has(v))

  /* ② 使用处对齐（真跑 decisions 的公开函数，不只看源码） */
  check(
    '★★ decisions.CONFIRM_REQUEST === 真值 request',
    decisions.CONFIRM_REQUEST === EV.request,
    String(decisions.CONFIRM_REQUEST),
  )
  const approval = decisions.timeoutEventOf(decisions.DECISION_TYPES.APPROVAL, 'c', 's').type
  const clarify = decisions.timeoutEventOf(decisions.DECISION_TYPES.CLARIFY, 'c', 's').type
  check(
    '★★ 审批收卡事件名 === 真值 approvalTimeout',
    approval === EV.approvalTimeout,
    approval,
  )
  check(
    '★★ 澄清收卡事件名 === 真值 clarifyTimeout',
    clarify === EV.clarifyTimeout,
    clarify,
  )

  /* ③ 不许各写一套：**代码行**里不再有这 3 个字面量（防止有人又写回去 —— 真收敛的钉子）。
     先去注释再扫：注释里提到名字是正常的（说明「这是什么」），不算「各写一套」。 */
  const src = readFileSync(join(ROOT, 'electron/core/decisions.cjs'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  for (const v of values) {
    check(
      `★ decisions.cjs 代码里不再硬写「${v}」（要改去 event-types.cjs）`,
      !code.includes(`'${v}'`),
      `还写着 '${v}'`,
    )
  }
}
