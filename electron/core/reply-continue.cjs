/**
 * 最终回复被截断时：识别、续写、拼接
 *
 * ── 为什么要有这个文件（2026-11-08 实测）─────────────────────
 *
 * 假上游实测三种结束方式，结果是：
 *
 * | 场景                     | 正文           | 用户看到的           | 落盘的   |
 * |--------------------------|----------------|----------------------|----------|
 * | 正常 `finish=stop`       | 306 字（完整）  | 完成                 | 完整     |
 * | `finish_reason: length`  | 150 字（丢一半）| **一条会消失的 toast** | 当成完整 |
 * | 中途断流（无 finish）     | 120 字          | **什么提示都没有**    | 当成完整 |
 *
 * 正文本身没丢（`loop-transcript` 的 `soFar()` 保住了），丢的是**「这条没写完」
 * 这个事实**：`chat.cjs` 的 `done` 事件只带 content / usage / turns / toolRuns，
 * 没有 finishReason，于是渲染层和会话存储都当它是完整回复。
 *
 * ── 三种「不完整」必须分开 ────────────────────────────────────
 *
 *   · `length`     —— 模型撞了输出上限。**还能接着写**，续写有意义。
 *   · `stream_cut` —— 没收到 finish_reason 就断了。续写也可能断，但试一次值得。
 *   · `aborted`    —— 用户自己按的停。**绝不续写**（他要停，你接着写是抗命）。
 *
 * 判据不靠「最后有没有句号」（中文这种判法基本无效），只看上游给的结构化信号。
 *
 * ── 续写为什么把 tools 传空 ──────────────────────────────────
 *
 * 续写是「把话说完」，不是「接着干活」。传 `tools: []` 之后模型**不可能**产生
 * 工具调用 —— 那就不存在重跑 `run_shell` / 改文件 / 再提交一次的可能。
 * 这比「事后过滤掉工具调用」可靠：脏东西压根进不来。
 */

/** 续写时给模型的指令（明确禁止重复，否则会得到两遍同样的段落） */
const CONTINUE_PROMPT =
  '你上一条回复因为输出长度限制被截断了。请**从断掉的地方接着往下写**，' +
  '不要重复已经写过的内容，不要重新开头，也不要调用任何工具 —— 只把剩下的那部分补完。'

/** 最多续几次。1 次能救回绝大多数情况；再多是模型在死循环，该停下来告诉用户 */
const MAX_CONTINUE = 2

/**
 * 这次调用算不算「没写完」。
 *
 * ── 为什么判据是 `sawDone === false` 而不是「没有 finish_reason」──────
 *
 * 2026-11-08 踩过：第一版拿「没有 finish_reason」判断流，结果 `05-agent-loop`
 * 那类打桩（返回对象里根本没这个字段）全被判成断流 → 触发续写 → **正文拼成两遍**。
 * `llm-stream-end.cjs` 的文件头早就写过这条会次次误报。
 *
 * 所以只认**显式**的 `sawDone === false`（上游流真的没给出收尾标记）：
 *   · 字段不存在（老调用方 / 打桩）→ **不知道，不判**，绝不续写
 *   · `[DONE]`（HTTP）或 `turn.completed`（CLI）到过 → 正常结束
 *
 * @param {{ finishReason?: string|null, sawDone?: boolean, content?: string, toolCalls?: unknown[] }} result
 * @returns {{ cut: boolean, reason: string, canContinue: boolean }}
 *   `reason` 取值：`''`（正常）/ `length` / `stream_cut`
 */
function classify(result) {
  const finish = String(result?.finishReason ?? '')
  const hasText = String(result?.content ?? '').length > 0
  const hasTools = Array.isArray(result?.toolCalls) && result.toolCalls.length > 0

  /* 有工具调用 = 这一轮还没到最后收尾，不是「总结被截断」 */
  if (hasTools) return { cut: false, reason: '', canContinue: false }
  /* 上游明确说撞了输出上限 —— 唯一 100% 可靠的截断信号，续写有意义 */
  if (finish === 'length') return { cut: true, reason: 'length', canContinue: true }
  /*
   * 流没给出收尾标记（且真的收到过正文）→ 断在半路。
   * ★ 必须**显式**是 `false` 才算证据；`undefined` = 不知道（老调用方 / 打桩）。
   */
  if (result?.sawDone === false && hasText) {
    return { cut: true, reason: 'stream_cut', canContinue: true }
  }
  return { cut: false, reason: '', canContinue: false }
}

/**
 * 拼两段正文，去掉重复的接缝。
 *
 * 模型被要求「接着写」时仍常常**把最后一句再重复一遍**（尤其是有小标题的总结）。
 * 这里找出 `head` 的尾巴与 `tail` 的开头最长的公共部分并切掉。
 *
 * 阈值定 10（不是 24）：中文一句话的接缝常常就是十来字（「这是第一段的最后一句。」
 * 只有 11 字）。24 那种量级会**放过真实的整句重复**，代价是用户看到一句话说两遍；
 * 而 10 字以上的完全匹配在自然语言里是巧合的概率极低，误切风险可接受。
 */
const MIN_OVERLAP = 10

function stripOverlap(head, tail) {
  const a = String(head ?? '')
  const b = String(tail ?? '')
  if (!a || !b) return b

  const max = Math.min(a.length, b.length, 600)
  for (let n = max; n >= MIN_OVERLAP; n -= 1) {
    if (a.slice(-n) === b.slice(0, n)) return b.slice(n)
  }
  return b
}

/**
 * 续写：拿第一段正文，再问一次模型要剩下的部分。
 *
 * ★ 调用方必须保证 `tools` 为空（见文件头）。这里只负责「问 + 拼 + 报」。
 *
 * @param {{ first: string, ask: (messages: Array<object>) => Promise<{ content: string, finishReason?: string }>,
 *           onDelta?: (text: string) => void, maxContinue?: number, messages: Array<object> }} input
 * @returns {Promise<{ text: string, continued: number, lastReason: string }>}
 */
async function continueWriting(input) {
  const limit = Math.max(0, Number(input.maxContinue ?? MAX_CONTINUE) || 0)
  let text = String(input.first ?? '')
  let continued = 0
  let lastReason = ''

  for (let i = 0; i < limit; i += 1) {
    const messages = [
      ...input.messages,
      { role: 'assistant', content: text },
      { role: 'user', content: CONTINUE_PROMPT },
    ]

    let got
    try {
      got = await input.ask(messages)
    } catch {
      /* 续写自己失败不该把已经拿到的正文一起弄丢 —— 停在这里，如实标「没写完」 */
      break
    }

    const piece = stripOverlap(text, String(got?.content ?? ''))
    if (!piece.trim()) break

    text += piece
    continued += 1
    lastReason = String(got?.finishReason ?? '')
    input.onDelta?.(piece)

    /* 这次写完了就别再续 */
    if (lastReason && lastReason !== 'length') break
  }

  return { text, continued, lastReason }
}

/**
 * 收尾前的一次总处理：判截断 → 需要就续 → 返回该拼什么。
 *
 * ★ `added` 与 `text` 是两个东西，别混：
 *   · `added` = **续写新增的那一段**。调用方把它当 `transcript.soFar(tail)` 的 tail 传进去
 *     （`mergeRound()` 已经把第一轮并进了总账，再传全文会得到「第一轮 + 第一轮+续写」）。
 *   · `text` = 完整正文（第一轮 + 续写），只用于「这条到底写完了没」的判断与日志。
 *
 * ★ 续写那段**整段到齐后发一次** `content`，不逐字：逐字发就没法在发之前去掉
 *   与上一段重复的接缝（见 `stripOverlap`）。几百字的补写，正确性优先于打字机效果。
 *
 * @param {{ result: object, baseArgs: object, messages: Array<object>, emit?: Function,
 *           callModel: Function, mergeRound?: Function, addUsage?: Function }} input
 * @returns {Promise<{ added: string, text: string, cut: boolean, reason: string, continued: number }>}
 */
async function completeReply(input) {
  const { result, baseArgs, messages, emit, callModel, mergeRound, addUsage } = input
  const first = String(result?.content ?? '')
  const verdict = classify(result)

  /* 没截断（或只是有工具调用）→ 原样交回去，一个字节不加 */
  if (!verdict.canContinue) {
    return { added: '', text: first, cut: verdict.cut, reason: verdict.reason, continued: 0 }
  }

  emit?.({ type: 'truncated', reason: verdict.reason, willContinue: true })
  /* 第一轮先并进总账：续写那段才成为「最后一轮终稿」 */
  mergeRound?.()

  const got = await continueWriting({
    first,
    messages,
    maxContinue: MAX_CONTINUE,
    /* 逐字回调用不上（见文件头），这里只接整段结果 */
    ask: async (msgs) => {
      const one = await callModel({
        ...baseArgs,
        messages: msgs,
        /* ★★ 续写不带工具：模型不可能产生工具调用 → 绝无重跑已完成的副作用 */
        tools: [],
        onContent: undefined,
        onReasoning: undefined,
        onUsage: (u) => addUsage?.(u),
      })
      return { content: one?.content ?? '', finishReason: one?.finishReason ?? '' }
    },
  })

  const added = got.text.slice(first.length)
  if (added.trim()) emit?.({ type: 'content', text: added, stage: 'answer' })

  /* 续完还是 length / 还是没 finish → 这条到底还是没写完，如实说 */
  const stillCut = Boolean(got.lastReason) ? got.lastReason === 'length' : got.continued > 0
  emit?.({
    type: 'truncated',
    reason: stillCut ? verdict.reason : '',
    willContinue: false,
    continued: got.continued,
  })

  return {
    added,
    text: got.text,
    cut: stillCut,
    reason: stillCut ? verdict.reason : '',
    continued: got.continued,
  }
}

module.exports = {
  classify,
  stripOverlap,
  continueWriting,
  completeReply,
  CONTINUE_PROMPT,
  MAX_CONTINUE,
}
