import type { MessageRound, ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   跨轮同类聚合（Phase 3 · 中央对话降噪）

   Phase 0 真机实测：连跑 6 轮 read_file → 界面上是 **6 行独立摘要**
   （每轮一个 `ToolLine`）。一轮只读一个文件时，6 行里 5 行是重复的姿势，
   把真正的正文挤下去。

   这里把**连续、可聚合**的若干轮折成一组（渲染层用一个 `ToolLine`
   一次说完「读取 6 个文件」，展开仍是 100 条原始明细，一条不少）。

   ── 三条硬边界（都由单测钉死）──

     · **只在一条消息内聚合**：入参就是单条消息的 `rounds`，跨消息根本够不着。
     · **强制打断**：只要连续轮里出现「失败 / 还在跑（可能等确认）/ 被拒 / 被拦」，
       或者**出现正文**，或者有**子代理卡**，聚合**立刻断开** ——
       宁可多出几张卡，也绝不把「失败」和「成功」折叠进同一个卡片
       （用户会误以为一切顺利）。
     · **单轮不聚合**：一轮没得聚合，保持原样（不为了统一而套壳）。

   ★ 这是**纯展示层派生**：只读 `rounds` + `toolRuns`，不碰任何 Runtime 状态、
     不解析模型自然语言。工具成败来自 `ToolRunRecord.ok` 这个**结构化事实**。
   ══════════════════════════════════════════════════════════════ */

/** 一条消息拆出来的渲染项：要么是原来的一轮，要么是折起来的一组 */
export type RoundItem =
  | { kind: 'round'; index: number; round: MessageRound }
  | { kind: 'group'; from: number; to: number; rounds: MessageRound[]; runs: ToolRunRecord[] }

export interface GroupOptions {
  /**
   * 这条消息开头挂了澄清卡（`message.clarify`）→ 整条**不跨轮聚合**。
   *
   * 澄清卡在时间线上是「动手之前先问」的语义节点；把问之前 / 之后的工具轮
   * 混进一张卡，读起来会对不上。宁可多几行，不误导。
   */
  clarify?: boolean
}

const NONE: readonly ToolRunRecord[] = []

/** 取某一轮引用的工具记录（下标可能越界 —— 落盘/读回版本不一致时，过滤掉） */
function runsOf(round: MessageRound, toolRuns: readonly ToolRunRecord[]): ToolRunRecord[] {
  const out: ToolRunRecord[] = []
  for (const at of round.tools) {
    const run = toolRuns[at]
    if (run) out.push(run)
  }
  return out
}

/**
 * 这一轮能不能并进聚合组。
 *
 * 打断条件（任一命中即不能聚合）：
 *   · 有正文       —— 正文是「这一轮要说的东西」，不能被折叠吞掉
 *   · 没有工具     —— 没东西可折
 *   · `ok !== true` —— 失败 / 还在跑（等确认 / 等权限）/ 被拦，都要单独站出来
 *   · 有 `subagent` —— 子代理卡**始终显示、不折叠**（用户能看到的只剩这张卡）
 */
export function isFoldableRound(round: MessageRound, runs: readonly ToolRunRecord[]): boolean {
  if (round.content.trim()) return false
  if (runs.length === 0) return false
  for (const run of runs) {
    if (run.ok !== true) return false
    if (run.subagent) return false
  }
  return true
}

/** 单轮 → 渲染项（不聚合时的原样包装） */
function asRound(round: MessageRound, index: number): RoundItem {
  return { kind: 'round', index, round }
}

/**
 * 把一条消息的轮次折成渲染项。
 *
 * 连续 ≥2 轮都能聚合才折；夹在中间的任何「不可聚合轮」都会把组切断
 * （所以「成功 A、失败 B、成功 C」会得到 group(A) + round(B) + group(C)，
 * 而不是把 A 和 C 并起来）。
 */
export function groupRounds(
  rounds: readonly MessageRound[],
  toolRuns: readonly ToolRunRecord[] = NONE,
  options: GroupOptions = {},
): RoundItem[] {
  /* 有澄清卡：整条不折（见 GroupOptions.clarify 的理由） */
  if (options.clarify) return rounds.map((round, index) => asRound(round, index))

  const items: RoundItem[] = []
  let i = 0
  while (i < rounds.length) {
    if (!isFoldableRound(rounds[i], runsOf(rounds[i], toolRuns))) {
      items.push(asRound(rounds[i], i))
      i += 1
      continue
    }

    /* 往后吃连续可聚合的轮 */
    const group: MessageRound[] = []
    const runs: ToolRunRecord[] = []
    let j = i
    while (j < rounds.length && isFoldableRound(rounds[j], runsOf(rounds[j], toolRuns))) {
      group.push(rounds[j])
      for (const run of runsOf(rounds[j], toolRuns)) runs.push(run)
      j += 1
    }

    /* 只有一轮：不聚合，保持原样 */
    if (group.length < 2) {
      items.push(asRound(rounds[i], i))
      i += 1
      continue
    }

    items.push({ kind: 'group', from: i, to: j - 1, rounds: group, runs })
    i = j
  }
  return items
}
