import { join, require, readFileSync, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   P0-5：Decision 一处真相源 + 两条往返的形状对齐

   「要用户拿主意」只有一条通道（`chat:confirm`）、一个事件名（`confirm_request`），
   靠 `decisionType` 区分审批 / 澄清。这一组钉的就是「这个类型集合两边一致、
   两条往返的公共字段都齐」—— 硬约束 9 的「形状只定义一处 + 字符串契约从源码
   抠出来真跑一遍」。

   ★ 为什么值得单列：审批那条**漏过 `sessionId`**（2026-10-07 僵尸卡 bug）——
     渲染层认领不到那张卡、还把它后面的澄清卡全挡死。这类「两条往返长得不一样」
     的坑，源码字符串断言拦不住，只有真跑两条往返、比对字段才拦得住。
   ══════════════════════════════════════════════════════════════ */

/** 两条往返的 `confirm_request` 事件都必须带的公共字段（形状对齐的落点） */
const COMMON_FIELDS = ['decisionType', 'confirmId', 'sessionId']

/** 跑一次往返，抓它推的 `confirm_request` 事件，抓到就结算掉（别留待办） */
async function askFor(type) {
  const bridge = require(join(ROOT, 'electron/core/confirm-bridge.cjs'))
  const chatConfirm = require(join(ROOT, 'electron/handlers/chat-confirm.cjs'))
  const seen = []
  const push = (event) => seen.push(event)
  const pending =
    type === 'approval'
      ? chatConfirm.askUser('req_shape', { name: 'run_shell', summary: 'x' }, push, 'sess_a', 5000)
      : chatConfirm.askClarify({
          sessionId: 'sess_c',
          taskId: 'task_c',
          questions: [{ question: 'q', options: [{ label: 'a', effect: '多花 1 秒' }] }],
          emit: push,
        })
  const evt = seen.find((one) => one.type === 'confirm_request') ?? null
  if (evt) bridge.settle(evt.confirmId, true)
  await pending.catch(() => {})
  return evt
}

function throws(fn) {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

export async function run() {
  const decisions = require(join(ROOT, 'electron/core/decisions.cjs'))
  const bridge = require(join(ROOT, 'electron/core/confirm-bridge.cjs'))
  const chatConfirm = require(join(ROOT, 'electron/handlers/chat-confirm.cjs'))

  group('P0-5 / 类型集合：主进程与渲染层**只定义一处**（谁改了忘同步就报红）')
  const backendTypes = [...decisions.ALL_DECISION_TYPES].sort()
  check(
    '主进程有 approval / clarify 两种',
    backendTypes.join(',') === 'approval,clarify',
    backendTypes.join(','),
  )

  /*
   * 渲染层那份从**源码**抠（不能 import TS）—— 抠 `export const DECISION_TYPES = [...]`。
   * 抠不到就报红（说明文件被改名 / 结构变了，镜像失联）。
   */
  const decisionTs = readFileSync(join(ROOT, 'src/types/decision.ts'), 'utf8')
  const matched = decisionTs.match(/export const DECISION_TYPES\s*=\s*\[([^\]]*)\]/)
  const frontTypes = matched
    ? [...matched[1].matchAll(/'([^']+)'/g)].map((one) => one[1]).sort()
    : []
  check('★ 渲染层镜像抠得到', frontTypes.length > 0, 'no-match')
  check(
    '★★ 两边集合相等（硬约束 9：跨模块约定一处真相源）',
    JSON.stringify(frontTypes) === JSON.stringify(backendTypes),
    `backend=${backendTypes.join(',')} front=${frontTypes.join(',')}`,
  )

  group('P0-5 / 未知类型当场抛（拼错的 type 不能静默走岔）')
  check('metaOf 未知类型抛错', throws(() => decisions.metaOf('nope')))
  check('decisionFields 未知类型抛错', throws(() => decisions.decisionFields('nope')))
  check('timeoutEventOf 未知类型抛错', throws(() => decisions.timeoutEventOf('nope')))
  check(
    'isDecisionType 认得真类型、不认假的',
    decisions.isDecisionType('approval') === true && decisions.isDecisionType('nope') === false,
  )

  group('P0-5 / 形状对齐：两条往返的 confirm_request 公共字段都得齐')
  const approveEvt = await askFor('approval')
  const clarifyEvt = await askFor('clarify')
  for (const [label, evt] of [
    ['审批', approveEvt],
    ['澄清', clarifyEvt],
  ]) {
    for (const key of COMMON_FIELDS) {
      check(
        `${label}事件带 ${key}`,
        evt != null && evt[key] !== undefined && evt[key] !== '',
        `evt=${JSON.stringify(evt ?? null).slice(0, 90)}`,
      )
    }
  }
  check(
    '★ 两条的 decisionType 分别对（审批=approval / 澄清=clarify）',
    approveEvt.decisionType === 'approval' && clarifyEvt.decisionType === 'clarify',
  )
  check(
    '★ confirmId 前缀按类型给（cfm_ / clr_）',
    String(approveEvt.confirmId).startsWith('cfm_') && String(clarifyEvt.confirmId).startsWith('clr_'),
  )
  bridge.reset()

  group('P0-5 / 收卡事件也带 decisionType（渲染层不必再按事件名反推）')
  const approveEvents = []
  await chatConfirm.askUser(
    'req_to2',
    { name: 'run_shell', summary: 'x' },
    (event) => approveEvents.push(event),
    'sess_t2',
    10,
  )
  const approveTimeout = approveEvents.find((event) => event.type === 'confirm.timeout')
  check(
    '审批超时收卡带 decisionType=approval + sessionId',
    approveTimeout != null &&
      approveTimeout.decisionType === 'approval' &&
      approveTimeout.sessionId === 'sess_t2',
    JSON.stringify(approveTimeout ?? null).slice(0, 90),
  )
  bridge.reset()

  const clarifyEvents = []
  await chatConfirm.askClarify({
    sessionId: 'sess_c2',
    taskId: 't2',
    questions: [{ question: 'q', options: [{ label: 'a', effect: '多花 1 秒' }] }],
    emit: (event) => clarifyEvents.push(event),
    timeoutMs: 10,
  })
  const clarifyTimeout = clarifyEvents.find((event) => event.type === 'clarify.timeout')
  check(
    '澄清超时收卡带 decisionType=clarify + sessionId',
    clarifyTimeout != null &&
      clarifyTimeout.decisionType === 'clarify' &&
      clarifyTimeout.sessionId === 'sess_c2',
    JSON.stringify(clarifyTimeout ?? null).slice(0, 90),
  )
  bridge.reset()

  group('P0-5 / 接线：渲染层按 decisionType 分流（不再靠 kind 猜）')
  const confirmEvents = readFileSync(join(ROOT, 'src/stores/thread/confirmEvents.ts'), 'utf8')
  check(
    "★ 分流判据里有 decisionType === 'clarify'",
    confirmEvents.includes("decisionType === 'clarify'"),
  )
  const chatConfirmSrc = readFileSync(join(ROOT, 'electron/handlers/chat-confirm.cjs'), 'utf8')
  check(
    '★ 两条往返都用 decisions.decisionFields 组装（形状一处出）',
    (chatConfirmSrc.match(/decisions\.decisionFields\(/g) ?? []).length === 2,
    String((chatConfirmSrc.match(/decisions\.decisionFields\(/g) ?? []).length),
  )
  check(
    "★ 两条往返都从 decisions 取 id 前缀（不再各写 'cfm' / 'clr'）",
    (chatConfirmSrc.match(/decisions\.idPrefixOf\(/g) ?? []).length === 2,
  )

  group('P0-5 / exitsIn 搬到 decisions.cjs 后行为不变（老路一字不差）')
  check('cancelled 解得出', decisions.exitsIn(JSON.stringify({ cancelled: true })).cancelled === true)
  check('rephrase 解得出', decisions.exitsIn(JSON.stringify({ rephrase: true })).rephrase === true)
  check('坏 JSON 当空对象（不把任务卡住）', JSON.stringify(decisions.exitsIn('{不是 JSON')) === '{}')
  check(
    'chat-confirm 仍把 askClarify 转出去（工具惰性 require 它）',
    chatConfirmSrc.includes('askClarify,'),
  )
}
