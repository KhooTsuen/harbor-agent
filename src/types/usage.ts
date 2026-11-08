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

/** 取「已知」的那部分合计：未知的一律不计入（不是加 0 冒充） */
export function knownTotalsOf(usage: MessageUsage | null | undefined): {
  prompt: number
  completion: number
  total: number
  cached: number
  reasoning: number
  requests: number
  unknown: number
} {
  if (!usage)
    return { prompt: 0, completion: 0, total: 0, cached: 0, reasoning: 0, requests: 0, unknown: 1 }
  if (!usage.known) {
    return { prompt: 0, completion: 0, total: 0, cached: 0, reasoning: 0, requests: 0, unknown: 1 }
  }
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
