import type { ContextInputEstimate, Message } from '@/types'
import type { ToolRunRecord } from '@/types/rounds'

/* ══════════════════════════════════════════════════════════════
   上下文用量口径（P1-B，2026-11-07）

   ── 病根 ──────────────────────────────────────────────────────

   以前 `estimateMessages` 只累加 `message.content.length` —— 完全不含
   `toolRuns`。而真实请求体里工具记录是**展开**进去的（`history.ts` 的
   `buildHistory` → `assistant(tool_calls)` + N 条 `tool`，每条 output 截 2000）。

   实测（两份真实会话，DeepSeek 分母 52,428 token）：

     sess_mw16：界面 29,047（55.4%）  实际 66,899（127.6%）  低估 2.3 倍
     sess_mw2ab：界面 76,502（145.9%） 实际 478,604（912.9%） 低估 6.3 倍

   后果不是「数字不好看」：自动压缩线（0.6）判的是那个**偏小的数**，
   于是「圈里才 55%，它已经超了」，而用户完全看不到这一层正在被裁。

   ── 这里的口径 ────────────────────────────────────────────────

   **逐条按「展开后的请求体形状」算**，公式与内核 `electron/core/context-text.cjs`
   的 `sizeOfMessage` 一一对应（同一个形状、同一组常量）。`contextUsageDrift.test.ts`
   把展开后的数组喂给内核那个函数，断言两边**逐条相等**（不是近似）——
   所以「两边各写一份规则」这件事有测试盯着，改一边忘另一边会红。

   ⚠️ 这是**字符换算的估算**，不是 API 计费 token。真正的计费数只有
   供应商返回的 `usage` 才是（`message.usage`）；两者不能混着说。
   ══════════════════════════════════════════════════════════════ */

/** 单条工具输出在历史里的上限 —— 与 `session-replay.cjs` 的 `OUTPUT_CAP` 同值 */
export const OUTPUT_CAP = 2000

/** 一张图按多少字符占预算 —— 与内核 `context-text.IMAGE_COST` 同值（不按 base64 真长算） */
export const IMAGE_COST = 800

/** 每条消息的形状开销（role / 分隔符 / tool_call_id）—— 与内核 `MESSAGE_OVERHEAD` 同值 */
export const MESSAGE_OVERHEAD = 12

/** 每个工具调用的形状开销（id + type + name + arguments 的包装）—— 与内核 `CALL_OVERHEAD` 同值 */
export const CALL_OVERHEAD = 24

/** 工具调用参数：老记录没存原始参数，一律 `{}`（见 `history.ts` 与 `session-replay.cjs`） */
const ARGS = '{}'

/**
 * 回放 id —— **唯一一处公式**。
 *
 * `history.buildHistory`（发请求）与这里的估算必须生成同一个 id，否则「工具占多少」
 * 和「实际发多少」差一截：ids 长度是逐字符算进预算的。主进程 `session-replay.cjs`
 * 那份是同一公式的另一侧（那边由自检 01 钉着）。
 */
export function replayCallIdOf(diskKey: string | undefined, id: string, k: number): string {
  const suffix = String(diskKey ?? id).slice(-8) || 'r'
  return `replay_${suffix}_${k}`
}

/** 字符当量 → token（内核 `estimateTokensOf` 是同一个公式：`ceil(chars / 3)`） */
export function estimateTokensOf(chars: number): number {
  return Math.ceil((Number(chars) || 0) / 3)
}

/** 一段文本 → token 估算 */
export function estimateTokens(text: string): number {
  return estimateTokensOf(String(text).length)
}

/**
 * 一条工具记录**在请求体里**占多少字符（只是那条 `tool` 消息的正文）。
 *
 * 与 `history.buildHistory` / `session-replay.replayToolRuns` 拼出来的那条 `tool`
 * 消息同形：`${name}: 成功|失败` + 换行 + output 的前 2000 字。
 */
function toolCharsOf(run: ToolRunRecord): number {
  const head = `${run.name}: ${run.ok ? '成功' : '失败'}`
  const output = run.output ? String(run.output).slice(0, OUTPUT_CAP) : ''
  return head.length + (output ? 1 + output.length : 0)
}

/**
 * 一条消息**在请求体里**占多少字符：正文 + 形状 + 展开的工具记录（+ 图片固定成本）。
 *
 * ★ 正文为空但带工具调用时**不是 0** —— 这正是 P1-A 修的同一个病灶在统计侧的镜像：
 *   模型只调工具不说话时 `content` 是空串，但 `tool_calls` 与它引出的一串 `tool`
 *   全都在请求体里占位置。
 *
 * ★ 图片也**不能按 base64 真长算**：一张 200KB 的图是 27 万字符，而 API 只按一千来个
 *   token 计 —— 照真长算，界面上「一张截图就占满上下文」会是个假警报。
 */
export function requestCharsOf(message: Message): number {
  /* 只有 user 消息会带图（`history.buildHistory` 里就这一条分支） */
  const images = message.role === 'user' ? (message.images?.length ?? 0) : 0
  let total = String(message.content ?? '').length + MESSAGE_OVERHEAD + images * IMAGE_COST

  const runs = message.role === 'assistant' ? (message.toolRuns ?? []) : []
  if (runs.length === 0) return total

  runs.forEach((run, k) => {
    const callId = replayCallIdOf(message.diskKey, message.id, k)
    /* 那条 assistant 里的 tool_calls 数组 */
    total += callId.length + String(run.name ?? '').length + ARGS.length + CALL_OVERHEAD
    /* 以及它引出的那条 tool 消息 */
    total += MESSAGE_OVERHEAD + callId.length + toolCharsOf(run)
  })
  return total
}

/** 一批消息 → token 估算（**按请求体口径**：含展开的工具记录与图片成本） */
export function estimateMessages(messages: readonly Message[]): number {
  return estimateTokensOf(messages.reduce((sum, m) => sum + requestCharsOf(m), 0))
}

/** 一条消息里工具记录占多少字符（用来解释「这个数为什么这么大」） */
export function toolCharsTotal(messages: readonly Message[]): number {
  let total = 0
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const run of message.toolRuns ?? []) total += toolCharsOf(run)
  }
  return total
}

/**
 * 用量的四个分项 —— 用户要能分清「存了多少」「准备发多少」「实际拼成多少」。
 *
 *  · `stored`     磁盘上这条会话的全部历史规模（含已被压缩点覆盖的部分）
 *  · `inContext`  压缩点之后、真正会拿去做上下文的那一段
 *  · `request`    按**请求体口径**估算的 token（= 上面那个 `inContext` 展开后）
 *  · `toolShare`  其中工具记录占的比例（>1 说明工具是主体，这很常见）
 */
export interface UsageBreakdown {
  storedMessages: number
  storedTokens: number
  inContextMessages: number
  requestTokens: number
  toolShare: number
}

export function breakdownOf(
  all: readonly Message[],
  inContext: readonly Message[],
): UsageBreakdown {
  const requestChars = inContext.reduce((sum, m) => sum + requestCharsOf(m), 0)
  return {
    storedMessages: all.length,
    storedTokens: estimateMessages(all),
    inContextMessages: inContext.length,
    requestTokens: estimateTokensOf(requestChars),
    toolShare: requestChars > 0 ? Number((toolCharsTotal(inContext) / requestChars).toFixed(2)) : 0,
  }
}

/**
 * 从事件里取 `input`（没有就是空对象，`patch` 展开它不会覆盖原值）。
 *
 * 判据只看「有没有这个 key 且是对象」——坏形状不抛错，界面照旧退回自算。
 */
export function inputOfEvent(event: Record<string, unknown>): {
  contextInput?: ContextInputEstimate
} {
  const input = event.input
  return input && typeof input === 'object' ? { contextInput: input as ContextInputEstimate } : {}
}
