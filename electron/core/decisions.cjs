/**
 * 决策（Decision）—— 「要用户拿主意」的统一模型（P0-5 架构收敛）
 *
 * 背景：一次对话里其实只有**一条往返**在跟用户来回（他「批一下 / 答一句」→
 * Agent 继续）。但它被两处上层各自组装过一遍：
 *   · 写操作审批（`handlers/chat-confirm.cjs` 的 `askUser`）→ 回话是布尔
 *   · 开工前澄清（同文件的 `askClarify`）→ 回话是结构化对象
 * 两条往返共用底层 `confirm-bridge.cjs`，可**上层事件形状曾经不一致**：
 * 2026-10-07 的僵尸卡 bug 就出在审批那条漏了 `sessionId`（渲染层认领不到那张卡）。
 *
 * 这个文件把「决策有哪些类型、每种什么脾气、事件长什么样、回话怎么解」定在**一处**：
 *   ① 类型集合 `DECISION_TYPES` —— 新增一种决策（恢复 / 回滚 / 半路改方向）= 在这里加一条
 *   ② 每种类型的元数据 `metaOf()` —— id 前缀 / 超时怎么算 / 超时收卡的事件名
 *   ③ 统一的事件组装 `decisionFields()` —— 两条往返都过它，公共字段天然对齐（硬约束 9）
 *   ④ 回话解析 `exitsIn()` —— 澄清那两个退出口（「先不做了」「换个说法」）
 *
 * ⚠️ **不 require electron**（自检 / 单测要能在纯 Node 里直接调它）。
 * 渲染层读同一份语义：TS 那边 `src/types/decision.ts` 是镜像，
 * `125-decision-shape` 自检钉住两边集合相等。
 *
 * ⚠️ 这里**不写「会涨的数字」**（硬约束 8）：类型几个看 `ALL_DECISION_TYPES.length`。
 */

/** 决策类型（新增一种在这里加，别在调用处再写一套字符串） */
const DECISION_TYPES = {
  /** 写操作审批：只有明确同意才放行，超时**算拒绝** */
  APPROVAL: 'approval',
  /** 开工前澄清：问用户拿主意，超时**按默认选项继续**（不是拒绝） */
  CLARIFY: 'clarify',
}

const ALL_DECISION_TYPES = Object.values(DECISION_TYPES)

/** 「问用户」那条事件的类型名（两条往返共用一条通道、一个事件名） */
const CONFIRM_REQUEST = 'confirm_request'

/**
 * 每种决策的「脾气」。新增类型在这里加一条 —— 调用处别再各写一套。
 *
 * `timeoutPolicy` 是这套模型里最要紧的一处语义（审批和澄清的区别全在这）：
 *   · `reject`         —— 超时算拒绝（他可能就是不想批）
 *   · `accept-default` —— 超时按默认选项继续（他人不在，不是拒绝；两者后果完全不同）
 */
const DECISION_META = {
  [DECISION_TYPES.APPROVAL]: {
    idPrefix: 'cfm',
    timeoutPolicy: 'reject',
    /** 超时 / 作废时要发给渲染层的「收卡」事件名 */
    timeoutEvent: 'confirm.timeout',
  },
  [DECISION_TYPES.CLARIFY]: {
    idPrefix: 'clr',
    timeoutPolicy: 'accept-default',
    timeoutEvent: 'clarify.timeout',
  },
}

function isDecisionType(value) {
  return ALL_DECISION_TYPES.includes(value)
}

/** 拿某个类型的元数据；未知类型**当场抛**（拼错的 type 必须现形，不能静默走岔） */
function metaOf(type) {
  const meta = DECISION_META[type]
  if (!meta) throw new Error(`未知的决策类型：${String(type)}`)
  return meta
}

/** 某个类型的 id 前缀（confirm-bridge 建 `cfm_…` / `clr_…` 时用） */
function idPrefixOf(type) {
  return metaOf(type).idPrefix
}

/**
 * 一条决策请求的**公共字段**（两条往返都 spread 进各自的 payload）。
 *
 * ★ 这是「形状只定义一处」的落点：审批和澄清的公共字段由这里给，谁都不会再漏
 *   一个（漏 `sessionId` 的僵尸卡就是这么来的）。各类型**专有**的字段
 *   （审批的 toolName/summary、澄清的 questions）仍由各自的调用处补。
 *
 * @param {string} type 决策类型（`DECISION_TYPES` 里的值）
 * @param {{ sessionId?: string, taskId?: string }} [ids]
 */
function decisionFields(type, ids = {}) {
  metaOf(type) /* 未知类型当场抛 */
  return {
    /*
     * ★ 分流字段：渲染层按它决定「这是审批还是澄清」。
     *   以前靠 `kind` 猜 —— 可审批的 `kind` 是工具种类（write/mcp/…）、
     *   澄清的 `kind` 恒为 'clarify'，同一个字段名两套值域（硬约束 9 要消灭的）。
     */
    decisionType: type,
    sessionId: String(ids.sessionId ?? ''),
    taskId: String(ids.taskId ?? ''),
  }
}

/** 超时 / 作废时的「收卡」事件（两条往返共用，形状也一致） */
function timeoutEventOf(type, confirmId, sessionId) {
  const meta = metaOf(type)
  return {
    type: meta.timeoutEvent,
    decisionType: type,
    confirmId: String(confirmId ?? ''),
    sessionId: String(sessionId ?? ''),
  }
}

/**
 * 解析澄清回话里的两个「退出口」（AG-053 批⑤）：「先不做了」「换个说法」。
 *
 * 它们和「跳过」走同一条 `chat:confirm`（`approved` 也是 false），区别只在
 * 回话 JSON 里多一个标记。★ 旧实现这个分支**直接 return，压根不看 reply.answer**
 * —— 那两个出口会被当成「用户跳过了」。后果不是错一句话，是错一个状态：
 * 跳过计数是静音的判据（连跳两次就不再主动问），而点「先不做了」的人只是
 * 「这次先不做」，他却会被当成「又拒了一次」。拿用户没说过的话去记他，是
 * 这里最不能接受的一种错。
 *
 * 解析失败 / 老版本界面 → 返回空对象，仍然当跳过（不能把任务卡住）。
 *
 * @param {unknown} answer 渲染层回的 JSON 字符串
 * @returns {{cancelled?: true, rephrase?: true}}
 */
function exitsIn(answer) {
  try {
    const value = JSON.parse(String(answer ?? '') || '{}')
    const out = {}
    /* ★ 名字必须是 `cancelled`：渲染层 `types/clarify.ts` 里就叫这个。
       写成 `cancel`（少一个 l）不会报错、不会抛异常 —— 只是「这两个出口总是被当成
       跳过」，而自检 107 组的真往返一次就把它抓出来了。 */
    if (value?.cancelled === true) out.cancelled = true
    if (value?.rephrase === true) out.rephrase = true
    return out
  } catch {
    return {}
  }
}

module.exports = {
  DECISION_TYPES,
  ALL_DECISION_TYPES,
  CONFIRM_REQUEST,
  isDecisionType,
  metaOf,
  idPrefixOf,
  decisionFields,
  timeoutEventOf,
  exitsIn,
}
