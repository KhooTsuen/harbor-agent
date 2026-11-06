/**
 * 按**消息组**从尾部挑近期消息（P1-A，2026-11-07）
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────
 *
 * `context-builder.assemble` 以前是**一条一条**从尾部往前取：
 *
 *     for (i = 末条; i >= 0 && remaining > 0; i--) { if (size > 0) selected.unshift(...) }
 *
 * 每条消息各自决定去留，于是必然产生两种残缺：
 *
 *   ① **空正文的 `assistant(tool_calls)` 算出来 0**（`sizeOf(content)`）→ 被跳过 →
 *      它后面那一串 `tool` 全成孤儿 → 配对校验把整组丢掉。实测 30 次工具调用 +
 *      空正文：62 条 → **2 条 / 13 字符**，30 条诊断结果一条不漏地消失。
 *   ② 尾部连续 26 条 `tool` 先被选中（它们各自有内容），而**组的开头**
 *      `assistant(tool_calls)` 在同一组的头部、早被额度挡在外面 → 26 条全是孤儿 →
 *      `completeToolGroups` 判「不完整」→ **整份历史清零**（真实会话实测 863 条 → 0 条）。
 *
 * ── 这里的规则（唯一一处）──────────────────────────────────────
 *
 *   · **逻辑组** = `assistant(tool_calls)` + 紧跟的一串 `tool`；其余消息单条成组。
 *   · 组内**要么整组进**，要么有明确降级（见下）—— 绝不把组的头和尾分开。
 *   · 额度不够放整组时，**跳过这一组继续往前**（不是就地停止）：剩下的额度还能装下
 *     更早的对话，那样模型至少有上下文，而不是「因为最后那组太大，整份历史清零」。
 *   · 完整工具组放不下时，**按尾部连续保留 `tool`，并把 `tool_calls` 裁成同一个子集**。
 *     保留的是真实发生过的那几次调用（不是编造），丢的是更早的几次（本来也进不来）。
 *     ⚠️ 不能只留部分 `tool` 而保留全部 `tool_calls` —— 那是**悬空调用**，上游 400。
 *   · 孤立 `tool`（找不到带对应 id 的 `assistant`）与悬空 `tool_calls` 一律不进。
 *
 * ── 顺带修掉的老毛病 ─────────────────────────────────────────
 *
 * 「被裁到只剩一行说明」的残片不要（`MIN_KEEP_CHARS`）：它占着预算，却不提供任何信息，
 * 模型只能看到一串「上下文已按预算裁剪」。宁可整条不进，由调用方统一报一句「少了 N 条」。
 */

/** 至少留这么多原文才值得把一条消息留下（见文件头的残片规则） */
const MIN_KEEP_CHARS = 200

/**
 * 一条消息是不是「完整工具组」的头：带工具调用，且紧跟的 `tool` 与 id 一一对应。
 *
 * 判据与 `completeToolGroups` 完全一致（同一件事不能两套标准）：
 * id 非空、组内不重名、条数相等、**顺序**也对得上。
 */
function toolGroupOf(list, index) {
  const head = list[index]
  const calls = head?.role === 'assistant' ? head.tool_calls : null
  if (!Array.isArray(calls) || calls.length === 0) return null
  let end = index + 1
  while (list[end]?.role === 'tool') end += 1
  const tools = list.slice(index + 1, end)
  const ids = calls.map((call) => call?.id)
  const complete =
    ids.every((id) => typeof id === 'string' && id.length > 0) &&
    new Set(ids).size === ids.length &&
    tools.length === ids.length &&
    tools.every((tool, k) => tool.tool_call_id === ids[k])
  return { head, tools, end, complete }
}

/**
 * 把消息列表切成逻辑组。
 *
 * @param {Array<object>} list
 * @returns {Array<{ messages: Array<object>, complete: boolean,
 *                   start: number, end: number }>}
 *          `complete=false` 的组（孤立 tool / 悬空 tool_calls）**一条都不会进上下文**。
 *          `start`/`end` 是它在原列表里的下标区间（`end` 不含）——
 *          「用户原话保住」那一步要靠它按原顺序还原。
 */
function groupMessages(list) {
  const source = Array.isArray(list) ? list : []
  const groups = []
  let i = 0
  while (i < source.length) {
    const group = toolGroupOf(source, i)
    if (group) {
      const end = group.end > i + 1 ? group.end : i + 1
      if (group.complete) {
        groups.push({ messages: [group.head, ...group.tools], complete: true, start: i, end })
      } else {
        /* 悬空 tool_calls：它自己不能留（调用没有结果），也不吞掉后面那些 tool —— 那些
           接下来会被各自认成孤立 tool。两头都丢掉，账目在 dropped 里如实计。 */
        groups.push({ messages: [group.head], complete: false, start: i, end })
      }
      i = end
      continue
    }
    const message = source[i]
    groups.push({ messages: [message], complete: message?.role !== 'tool', start: i, end: i + 1 })
    i += 1
  }
  return groups
}

/**
 * 从尾部往前挑消息，装到额度用完为止。
 *
 * @param {Array<object>} list 已经展开成 API 形状的历史（assistant/tool_calls + tool）
 * @param {number} budget 这一层的字符额度
 * @param {{ sizeOfMessage: Function, trimMessage: Function }} helpers
 *        文本口径必须由调用方传进来（唯一实现在 `context-text.cjs`）——
 *        本文件不自己算一次数，否则就是第二份会漂的规则
 * @returns {{ messages: Array<object>, dropped: number, invalid: number, remaining: number,
 *             chars: number }}
 *          `dropped` = 没进上下文的**原始条数**；其中 `invalid` = 因工具协议不完整被排除的。
 *          两者分开报：「预算不够」和「记录残缺」该让用户看到不同的原因
 */
function selectMessages(list, budget, helpers) {
  const { sizeOfMessage, trimMessage } = helpers
  const groups = groupMessages(list)
  /* 记下每一组在原列表里的区间 —— 「保住用户原话」那一步要按原顺序重排 */
  const picked = []
  let remaining = Math.max(0, Number(budget) || 0)
  let dropped = 0
  let invalid = 0
  let chars = 0

  for (let g = groups.length - 1; g >= 0; g -= 1) {
    const group = groups[g]
    if (!group.complete) {
      dropped += group.messages.length
      invalid += group.messages.length
      continue
    }
    if (remaining <= 0) {
      dropped += group.messages.length
      continue
    }

    /* ① 整组放得下：原样进（不改一个字） */
    const sizes = group.messages.map((m) => sizeOfMessage(m))
    const total = sizes.reduce((sum, n) => sum + n, 0)
    if (total <= remaining) {
      picked.unshift({ group, messages: group.messages, size: total })
      remaining -= total
      chars += total
      continue
    }

    /* ② 单条组：按剩余额度裁（老行为，含「残片不要」那条规则） */
    if (group.messages.length === 1) {
      const only = group.messages[0]
      const original = sizes[0]
      const copy = trimMessage(only, remaining)
      const size = sizeOfMessage(copy)
      if (size > 0 && !(size < MIN_KEEP_CHARS && size < original)) {
        picked.unshift({ group, messages: [copy], size })
        remaining -= size
        chars += size
        continue
      }
      dropped += 1
      continue
    }

    /* ③ 完整工具组放不下：保尾部连续几条 tool，并把 tool_calls 裁成同一子集 */
    const partial = partialToolGroup(group.messages, remaining, helpers)
    if (!partial) {
      dropped += group.messages.length
      continue
    }
    picked.unshift({ group, messages: partial.messages, size: partial.size })
    remaining -= partial.size
    chars += partial.size
    dropped += group.messages.length - partial.messages.length
  }

  /*
   * ④ 收尾：**用户原话优先**。
   *
   * 上面是纯按「离现在多远」挑的，于是在极端会话里会出现这种事（P0 的真实样本
   * `sess_mw16gqqesenmq.jsonl`：一轮 836 次工具调用，展开 866 条，字符额度只够 177 条）：
   * 装进来的是最近 170 条工具结果，而**这句任务到底要干什么**被挤出去了。
   *
   * 为什么用户原话值得优待：
   *   · 工具结果丢了，模型可以重跑一遍（代价是时间）；
   *   · 用户原话丢了，模型只能回头问用户 —— 那正是「上下文连续性」要消灭的事。
   *   · 它通常很短（几十到几千字），挤掉一条工具结果就够。
   *
   * 做法：对「没进来」的用户原话，按**从新到旧**补；额度不够就从**最靠前的**
   * （最旧、价值最低的）已选组里腾 —— 只腾工具组与 assistant 正文，不腾别的用户原话。
   * 腾完仍放不下就如实放弃（不无限折腾，也不假装放进去了）。
   */
  const isUserGroup = (entry) => entry.group.messages.length === 1 && entry.group.messages[0]?.role === 'user'
  const missingUsers = groups.filter(
    (group) => group.complete && group.messages.length === 1 && group.messages[0]?.role === 'user',
  )
  for (const group of missingUsers) {
    const message = group.messages[0]
    if (picked.some((entry) => entry.group === group)) continue
    let need = sizeOfMessage(trimMessage(message, Math.max(remaining, MIN_KEEP_CHARS)))
    /* 剩余额度不够 → 从最旧的已选组开始腾（跳过用户原话） */
    while (need > remaining) {
      const victim = picked.findIndex((entry) => !isUserGroup(entry))
      if (victim < 0) break
      const [evicted] = picked.splice(victim, 1)
      remaining += evicted.size
      chars -= evicted.size
      dropped += evicted.messages.length
    }
    if (need > remaining) continue
    const copy = trimMessage(message, remaining)
    const size = sizeOfMessage(copy)
    if (size <= 0 || size > remaining) continue
    picked.push({ group, messages: [copy], size })
    remaining -= size
    chars += size
    need = size
  }
  /* 按原顺序拼回去（上面几轮 unshift / push 都可能打乱） */
  picked.sort((a, b) => a.group.start - b.group.start)

  return {
    messages: picked.flatMap((entry) => entry.messages),
    dropped,
    invalid,
    remaining,
    chars,
  }
}

/**
 * 完整工具组装不下时，保留**最靠近现在**的若干次调用。
 *
 * ⚠️ 为什么必须同时裁 `tool_calls`：只留一部分 `tool` 消息、而 `assistant` 仍声明
 *    全部调用 → 上游报「tool_call_id 无对应」。做法是取真实存在的那几条 `tool`
 *    （**不编造**参数与结果），其余视为没进上下文。
 *
 * 从组尾往前累加（最近的那次最有用），遇到放不下的就停 —— 保出来的一定是**连续**的一段，
 * 不会出现「第 3 次在、第 5 次不在、第 7 次又在」这种断档。
 */
function partialToolGroup(messages, remaining, helpers) {
  const { sizeOfMessage, trimMessage } = helpers
  const head = messages[0]
  const tools = messages.slice(1)
  const kept = []
  let used = 0
  for (let k = tools.length - 1; k >= 0; k -= 1) {
    const size = sizeOfMessage(tools[k])
    if (used + size > remaining) break
    kept.unshift(tools[k])
    used += size
  }
  if (kept.length === 0) return null

  const keepIds = new Set(kept.map((tool) => tool.tool_call_id))
  const calls = (Array.isArray(head.tool_calls) ? head.tool_calls : []).filter((call) =>
    keepIds.has(call?.id),
  )
  if (calls.length === 0) return null

  /* 组头（assistant）也要放得下：它的正文通常很短，实在挤不下就裁正文（不带正文的
     assistant(tool_calls) 是合法消息 —— 模型只调工具不说话时就是这个形状） */
  let headCopy = { ...head, tool_calls: calls }
  let headSize = sizeOfMessage(headCopy)
  if (headSize + used > remaining) {
    headCopy = trimMessage(headCopy, Math.max(0, remaining - used - 12))
    headSize = sizeOfMessage(headCopy)
  }
  if (headSize + used > remaining) return null

  return { messages: [headCopy, ...kept], size: headSize + used }
}

module.exports = { MIN_KEEP_CHARS, groupMessages, selectMessages }
