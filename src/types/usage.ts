/* ══════════════════════════════════════════════════════════════
   一条回复的**真实** usage（服务商上报，归一后的形状）

   ── 为什么和 `UsageBucket` 分开（2026-11-09）────────────────────

   `UsageBucket`（`types/stats.ts`）是**累计桶**：旧统计页把一堆请求加起来，
   所以字段都是 `number`，老记录按 0 补。它回答「一共花了多少」。

   这一份是**单次请求**：服务商可能根本没给，也可能只给了一部分。所以：

     · 每个字段都可以是 `null` —— `null` = 这次没上报，**不是 0**。
     · `known` 说清这次到底有没有拿到真实用量。
     · 明确返回 0 时字段就是 `0`（`known: true`），与 `null` 区分开。

   两者混用会出现「未知被当成 0 加起来」——那正是这一层要根除的东西。

   ── 缓存与思考的语义 ────────────────────────────────────────────

   · `cached` **含在 `prompt` 里**（DeepSeek 的 hit+miss = prompt，
     OpenAI 的 `prompt_tokens_details.cached_tokens` 也是 prompt 的子集）
     → 累加时**绝不再加一遍**。
   · `reasoning` 属于 `completion`（推理按输出计费），不是并列两桶。

   ══════════════════════════════════════════════════════════════ */

export interface MessageUsage {
  /** 输入 token（服务商口径） */
  prompt: number | null
  /** 输出 token（含思考） */
  completion: number | null
  /** 服务商给的 total；没给但 prompt/completion 都有数时由内核算出来 */
  total: number | null
  /** 缓存命中（**含在 prompt 内**，别再加） */
  cached: number | null
  /** 缓存未命中（只有 DeepSeek 给） */
  cacheMiss: number | null
  /** 思考 token（含在 completion 内） */
  reasoning: number | null
  /**
   * 这次到底有没有拿到真实用量。
   * `false` = 没上报（失败 / 中止 / 这家不给）→ 界面显示「无数据」，**不显示 0**。
   */
  known: boolean
  /** 缓存字段来自哪种方言：`deepseek-style` / `openai-style` / `unavailable` */
  source: string
}

/**
 * 取「已知」的那部分合计：未知的一律不计入（不是加 0 冒充）
 *
 * ★ 2026-11-09 修：「没有 usage 字段」和「请求了但没上报」是**两件事**。
 *   `usage === undefined` 的消息（用户消息、老消息、从没跑过模型的消息）
 *   **根本没发过请求**，以前却返回 `unknown: 1` —— 于是「另有 N 次请求没有
 *   用量上报」的 N 里混着用户自己说的话。真机上一次 hello 之后就显示
 *   「另有 1 次请求没有用量上报」，那条其实是用户消息。
 *   只有 `usage` 存在且 `known === false` 才是「发了但没上报」。
 */
export function knownTotalsOf(usage: MessageUsage | null | undefined): {
  prompt: number
  completion: number
  total: number
  cached: number
  reasoning: number
  requests: number
  unknown: number
} {
  const zero = { prompt: 0, completion: 0, total: 0, cached: 0, reasoning: 0, requests: 0 }
  /* 没有 usage 字段 = 这条消息没发过请求，既不算已知也不算未知 */
  if (!usage) return { ...zero, unknown: 0 }
  /* 发了、但服务商没上报 → 这次消耗**未知**（不计入合计，也不当 0） */
  if (!usage.known) return { ...zero, unknown: 1 }
  return {
    prompt: usage.prompt ?? 0,
    completion: usage.completion ?? 0,
    total: usage.total ?? (usage.prompt ?? 0) + (usage.completion ?? 0),
    cached: usage.cached ?? 0,
    reasoning: usage.reasoning ?? 0,
    requests: 1,
    unknown: 0,
  }
}
