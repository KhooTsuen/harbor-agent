import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   卡「作废」时要**回推收卡事件**（2026-10-07）

   为什么单列一组（本来这几条写在 `101-confirm-bridge.mjs`，把它撑到 319 行）：
   101 钉的是「往返的**形状**」（老路径不变松、答复能带回），而这里钉的是
   「卡**作废/超时**时界面收不收得到通知」—— 两件事，挤在一起只会互相顶。

   ★ 背景（真机复现的 bug）：审批卡超时后主进程按**拒绝**继续，渲染层却收不到
     任何事件 —— 卡烂在输入框上方，`pickAboveInput` 永远让权限优先，后面
     **所有澄清卡都被它挡住**：用户「收不到提问卡」、界面一直「正在进行中」。
     澄清那侧早就有对称的 `clarify.timeout`，审批这侧漏了。

   ★ 还有一条**必须钉住**的：收卡事件得带 `sessionId`。渲染层按 `threadId`
     认领这张卡属于哪条对话，字段空着就永远匹配不上 —— 收了通知也清不掉卡
     （2026-10-07 真机第二次复现：加了事件、没带 id，僵尸卡照样在）。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  const bridge = require(join(ROOT, 'electron/core/confirm-bridge.cjs'))
  const chatConfirm = require(join(ROOT, 'electron/handlers/chat-confirm.cjs'))

  group('卡作废 / 审批卡超时 → 回推「收卡」事件（confirm.timeout）')
  bridge.reset()
  const approveEvents = []
  const approveTimeout = await chatConfirm.askUser(
    'req_to',
    { name: 'run_shell', summary: '跑条命令' },
    (event) => approveEvents.push(event),
    'sess_to',
    10,
  )
  const approveCard = approveEvents.find((e) => e.type === 'confirm_request')
  const approveClosed = approveEvents.find((e) => e.type === 'confirm.timeout')
  check(
    '★ 审批卡超时 → 回推 confirm.timeout（不收卡会把后面所有澄清卡挡死）',
    approveCard != null &&
      approveClosed != null &&
      approveClosed.confirmId === approveCard.confirmId &&
      String(approveClosed.confirmId).startsWith('cfm_'),
    JSON.stringify(approveEvents.map((e) => e.type)),
  )
  check('★ 审批卡超时后返回值仍是 false（老路径一字不差）', approveTimeout === false)
  check(
    '★ 收卡事件带着 sessionId（渲染层按 threadId 认领；漏了照样清不掉卡）',
    approveClosed != null && approveClosed.sessionId === 'sess_to',
    JSON.stringify(approveClosed ?? null).slice(0, 90),
  )

  group('卡作废 / 用户正常同意时**不**多推收卡事件')
  bridge.reset()
  const settleEvents = []
  const settledOk = chatConfirm.askUser(
    'req_ok',
    { name: 'run_shell', summary: 'x' },
    (event) => settleEvents.push(event),
    'sess_ok',
    5000,
  )
  bridge.settle(settleEvents[0].confirmId, true)
  check(
    '★ 用户正常同意时不发 confirm.timeout（那一侧由点击收卡）',
    (await settledOk) === true && !settleEvents.some((e) => e.type === 'confirm.timeout'),
    JSON.stringify(settleEvents.map((e) => e.type)),
  )
  bridge.reset()
}
