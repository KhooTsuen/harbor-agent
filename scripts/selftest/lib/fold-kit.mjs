/**
 * P0-1 折叠闸门自检的**共用夹具**（185 / 186 两组都用它）
 *
 * ⚠️ 这是**子模块**，不是自检组：放在 `lib/` 下，不进 `groups.mjs` 清单。
 *
 * ── 为什么抽出来（两个原因，都不小）─────────────────────────────
 *
 * ① 185 组加了「卡片往返」之后 343 行，破了硬约束 #2；而 186 组要一模一样的
 *    造数 / 打桩 / 点卡逻辑 —— 抄一份就是两处各写一套（硬约束 #9 要消灭的）。
 * ② 这里有一处**形状约定**必须只有一份：`send()` 怎么走真实入口
 *    （`windowHistory` → `runTurn`）、点卡时回话长什么样
 *    （`{ skipped, answers: [{ question, choice, text }] }`）。
 *    两边各写一份的话，主进程改了回话形状只会绿一边。
 *
 * ── 判据为什么可信 ────────────────────────────────────────────
 *
 * 走的是**真实调用链**：`chat-parts.windowHistory`（`chat:send` 用的那一个）→
 * `chat-run.runTurn`（单模型与协作都过它）→ `loop.run`（被换成计数器）→
 * 卡片那一段是真的 `chat-confirm.askClarify` → `confirm-bridge`。
 * 所以「Provider 调用 0 次」是数出来的，「用户点了继续」是真的走了一次 IPC 往返。
 */

import { join, ROOT, SANDBOX, configModule, require as req } from '../env.mjs'

export const windowCore = req(join(ROOT, 'electron/core/history-window.cjs'))
export const foldCore = req(join(ROOT, 'electron/core/history-fold.cjs'))
export const chatParts = req(join(ROOT, 'electron/handlers/chat-parts.cjs'))
export const chatRun = req(join(ROOT, 'electron/handlers/chat-run.cjs'))
export const loopCore = req(join(ROOT, 'electron/core/loop.cjs'))
export const bridge = req(join(ROOT, 'electron/core/confirm-bridge.cjs'))
export const decisions = req(join(ROOT, 'electron/core/decisions.cjs'))

/** 闸门模块（可能还不存在：不存在时让它整个 null，断言有序变红而不是整组崩） */
export function gateOf() {
  try {
    return req(join(ROOT, 'electron/core/fold-gate.cjs'))
  } catch {
    return null
  }
}

const PAD = '这一段是背景说明，只交代手册的来历。'

/** 一轮「用户原话 + 助手跑工具」的展开后消息（形状与 session-replay 一致） */
export function turnOf(userText, toolCount, conclusion) {
  const ids = Array.from({ length: toolCount }, (_, i) => `kit_${i}`)
  return [
    { role: 'user', content: userText },
    {
      role: 'assistant',
      content: conclusion,
      tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } })),
    },
    ...ids.map((id, i) => ({ role: 'tool', tool_call_id: id, content: `read_file: 成功\nout#${i}` })),
  ]
}

/**
 * 造一条长度确定、把 `requireText` 放在**中段**的用户原话。
 *
 * 折叠口径是「开头一半 + 结尾一半」，中段必被截掉 —— 位置要落在
 * `[cap/2, total-cap/2)` 之间，这里取正中间。
 */
export function longText(total, requireText) {
  const half = Math.floor(total / 2)
  const head = PAD.repeat(Math.ceil((half - requireText.length) / PAD.length)).slice(0, half - requireText.length)
  const body = `${head}${requireText}`
  return `${body}${PAD.repeat(Math.ceil(total / PAD.length)).slice(0, total - body.length)}`
}

/** 折叠块里那条「用户原话」消息 */
export function foldedUser(messages) {
  return (Array.isArray(messages) ? messages : []).find(
    (m) => m.role === 'user' && String(m.content).includes('折叠记录'),
  )
}

/* ── Provider 那一段的桩：数调用次数，并留住「真正发出去的那份历史」 ── */
let providerCalls = 0
let lastHistory = []
const originalRun = loopCore.run

export function stubLoop() {
  providerCalls = 0
  lastHistory = []
  loopCore.run = async (args) => {
    providerCalls += 1
    lastHistory = Array.isArray(args?.history) ? args.history : []
    return { content: '（测试桩：这一轮正常发出去了）', reasoning: '', usage: null, turns: 1, toolRuns: [] }
  }
}

export function restoreLoop() {
  loopCore.run = originalRun
}

/** 这一轮 Provider 被调了几次 / 真正发出去的历史（最近一次 stubLoop 之后） */
export function calls() {
  return providerCalls
}
export function sentHistory() {
  return lastHistory
}

/** 等确认卡出现（最多 1s）；没弹就返回 null，让断言去红而不是整组卡死 */
function waitCard(events, ms = 1000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      const card = events.find((one) => one?.type === decisions.CONFIRM_REQUEST)
      if (card) return resolve(card)
      if (Date.now() - started > ms) return resolve(null)
      setTimeout(tick, 5)
    }
    tick()
  })
}

/**
 * 走**真实入口**发一次。
 *
 * @param {string} sessionId
 * @param {Array<object>} rawHistory
 * @param {string} phaseKey
 * @param {string|null} choice 用户在确认卡上点的出口（`null` = 关掉卡 / 没确认）
 * @returns {Promise<{ value?: object, error?: Error, card: object|null, events: Array<object>,
 *                     calls: number, history: Array<object>, lossy: Array<object>, omitted: string }>}
 *          `error` 有值 = 这一轮被拦下（**不抛**，交给断言读；抛了就分不出「失败」和「拦住」）
 */
export async function send(sessionId, rawHistory, phaseKey, choice = null) {
  const { history, omitted, lossy } = chatParts.windowHistory(rawHistory, 20)
  const events = []
  stubLoop()
  const running = chatRun
    .runTurn({
      payload: {},
      mode: 'pair',
      controller: new AbortController(),
      pause: { requested: false },
      emit: (event) => events.push(event),
      confirm: async () => true,
      workdir: SANDBOX,
      effective: configModule.get(),
      sessionId,
      phaseKey,
      history,
      rawHistory,
      foldLossy: lossy,
    })
    .then((value) => ({ value }))
    .catch((error) => ({ error }))
  const card = await waitCard(events)
  if (card) {
    const answer = JSON.stringify({
      skipped: choice === null,
      answers:
        choice === null
          ? []
          : [{ question: String(card.questions?.[0]?.question ?? ''), choice, text: '' }],
    })
    bridge.settle(card.confirmId, choice !== null, answer)
  }
  const settled = await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve({ error: new Error('超时：这一轮没有结束') }), 4000)),
  ])
  const out = { ...settled, card, events, calls: providerCalls, history: lastHistory, lossy, omitted }
  restoreLoop()
  return out
}
