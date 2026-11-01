import type { MessageRound } from '@/types'

/* ══════════════════════════════════════════════════════════════
   收尾那份「汇总全文」该写到哪里

   为什么单独一个纯函数：`streamEvents.ts` 贴着 300 行红线，塞不下解释；而这段
   规则是**用户报过四次的可见故障**，必须有单测钉住（`finalRounds.test.ts`）。

   病根（第一次）：done 分支把**汇总全文**当成「新的一轮」push 进去。只要上游
   汇总文本与逐轮流式文本差一个字符（trim、补一句都算），界面上就是整段两遍。

   ★ 「不同」分两种，绝不能一视同仁：双模型协作时流式过程是「规划与执行过程」、
   收尾汇报是「最终协作汇报」—— 这两段**本来就不一样**，必须都显示。
   所以判据是**重合度**，不是「等不等」。

   规则（按顺序，命中即返回）：
     0. 每一轮先折掉「同一轮内的重复」：行级重复（`dropRepeatedLines`）与
        字符级「重试前半截 + 重试后整段重说」（`foldRestart`，第四种形状）
     1. 全文为空 → 原样（done 没带 content）
     2. **最后一轮**已经是这段文字 → 原样（协作场景下「最后写的就是汇报」）
     3. 忽略空白后与已有正文拼接**相同** → 原样
     4. 一条正文轮都没有 → 填最后一轮（没有才建一轮）—— 唯一允许「写进去」
     5. 与已有拼接**高度重合**（前缀 + 后缀覆盖 ≥ 90%）→ 就地补齐，不新增
     6. 其余 → 新增一轮（协作汇报 / 真的换了说法）
   ══════════════════════════════════════════════════════════════ */

/** 去掉所有空白后的样子（用来判「是不是同一份」，不管排版差异） */
function tight(text: string): string {
  return String(text ?? '').replace(/\s+/g, '')
}

/** 两个串的公共前缀长度 */
function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i += 1
  return i
}

/** 两个串的公共后缀长度（从末尾往前比） */
function commonSuffix(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1
  return i
}

/**
 * 两段文字「有多大比例是同一份」—— 用**前缀 + 后缀**覆盖，而不是只看前缀。
 *
 * ★ 2026-10-21 第二次修「整段显示两遍」：只算公共前缀时，收尾复核把**中间**
 *   一个字符改掉（或出现一个乱码字符），前缀就在那里断掉 —— 于是同一份内容
 *   被判成「另外一段话」，走第 6 条把全文 push 成新的一轮，界面上整段两遍。
 *
 *   实测本机 5 条真实消息：拼接与 final 长度只差 3~9 个字符，但公共前缀只有
 *   21%~80%（中途一处差异）；算上后缀后覆盖度 93%~100%，都是同一份。
 */
function coverage(a: string, b: string): number {
  const short = Math.min(a.length, b.length)
  if (short === 0) return 1
  const head = commonPrefix(a, b)
  /* 后缀不许与前缀重叠（重叠会把「同一段被数两遍」算成超过 100%） */
  const tail = Math.min(commonSuffix(a, b), short - head)
  /* 分母取**较短的一方**：短的那份整个都出现在长的里面（final 补了尾巴）就该算 100% */
  return (head + tail) / short
}

/**
 * 把 final 的**开头 / 结尾**里「已经在时间线上显示过的行」剥掉。
 *
 * ★ 2026-10-21 第三次修「整段显示两遍」，用户原话：「这不是流式消失，就是工作过程
 *   不是完了吗，那不得发个总结吗？就那处会有重复」。
 *
 *   前两次修的是「拼接与全文几乎相同」：覆盖度 ≥ 90% 就地补齐。但真实常见形态是
 *   **总结里复述了刚显示完的那一段，后面再补新内容**：
 *
 *       轮0 过程 … 轮1 刚才那段 ┐ 逐字流式时已经看到
 *       轮2 刚才那段 + ## 总结  ┘ ← 前缀被轮0 挡掉、后缀被新总结挡掉，覆盖度算成 0
 *
 *   于是整份 final 被 push 成新的一轮，「刚才那段」就显示两遍。这里按**行**比对：
 *   开头 / 结尾连续出现过的行剥掉，中间不动（总结里零星提到一句不算复述）。
 *
 *   短行（< 12 字：标题、列表符号、分隔线）不参与比对 —— 否则会把总结的骨架
 *   也当成复述剥掉。一行都没剥到就原样返回（不碰排版）。
 *
 * @param everywhere true = **所有**出现过的大行都剥（用于「同一份内容」的第 5 条：
 *   那时 final 基本是已显示内容的重排/复述，重复的行就是重复）；默认只剥首尾
 *   （第 6 条那种「另外一段话」，中间引用原文是合理的，不能删）。
 */
function stripShown(text: string, shown: string, everywhere = false): string {
  const lines = text.split('\n')
  const seen = (line: string): boolean => {
    const t = tight(line)
    return t.length >= 12 && shown.includes(t)
  }

  if (everywhere) {
    const kept = lines.filter((line) => !tight(line) || !seen(line))
    return kept.length === lines.length ? text : kept.join('\n').trim()
  }

  let start = 0
  let removed = 0
  while (start < lines.length) {
    if (!tight(lines[start])) {
      start += 1
      continue
    }
    if (!seen(lines[start])) break
    removed += 1
    start += 1
  }

  let end = lines.length
  while (end > start) {
    if (!tight(lines[end - 1])) {
      end -= 1
      continue
    }
    if (!seen(lines[end - 1])) break
    removed += 1
    end -= 1
  }

  if (removed === 0) return text
  return lines.slice(start, end).join('\n').trim()
}

/**
 * 把「同一个长行出现第二遍」的地方折成一次（**代码块内不动**）。
 *
 * ★ 2026-10-21 真机抓到的第三种形状：模型在**同一轮里**先给结论、又在总结里
 *   原样复述一遍 —— `rounds` 只有一条，`content` 与该轮逐字相同，第 2 条直接
 *   原样返回，于是屏幕上「结论 → 收尾总结 → 同一句再来一遍」（真机 keyTimes=2）。
 *
 *   这里按行去重：整行（去空白后 ≥ 12 字）若在**更早位置逐字出现过**，只留第一次。
 *   · 代码块（``` 之间）完全不参与 —— 代码要完整，重复行常常是正常的；
 *   · 短行（标题 / 列表符号 / 分隔线）不参与 —— 否则会把结构也吞掉；
 *   · 没有重复行时原样返回同一个字符串（不制造无谓改动）。
 */
function dropRepeatedLines(text: string): string {
  if (!text.includes('\n')) return text
  const lines = text.split('\n')
  const seen = new Set<string>()
  let inCode = false
  let removed = 0
  const kept: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode
      kept.push(line)
      continue
    }
    const t = tight(line)
    if (inCode || t.length < 12) {
      kept.push(line)
      continue
    }
    if (seen.has(t)) {
      removed += 1
      continue
    }
    seen.add(t)
    kept.push(line)
  }
  return removed === 0 ? text : kept.join('\n')
}

/**
 * 把「重试前已经流出去的那截」折掉 —— 第四种重复形状（2026-10-21 真机抓到的）。
 *
 * 上游流到一半报可重试的错（限流 / 超时）时 `callModel` 会**重新请求整段**；渲染层
 * 只把新分片往后追加（`retry` 事件目前只提示、不回滚），于是同一轮里变成「半截 +
 * 整段重说」，界面上那句显示两遍。两条判据，命中即返回：
 *   ① 这一轮忽略空白后**以 final 结尾**，且前面那段（重试前的半截）是 final 的开头
 *      → 后半段就是重发的那份，只留它（精确，优先）
 *   ② 没有 final 可锚：这一轮开头 ≥ 16 字在紧后面又原样说了一遍 → 丢掉开头那份
 *      （代码块里有 ``` 时不做 ②：代码里的重复常常是正常的）
 */
function foldRestart(text: string, finalText: string): string {
  const t = tight(text)
  if (t.length < 24) return text

  /* ① 精确：final 是重发的那份 */
  const b = tight(finalText)
  if (b.length >= 12 && t.length > b.length && t.endsWith(b)) {
    const head = t.slice(0, t.length - b.length)
    if (head.length >= 12 && b.startsWith(head)) return cutByTightPrefix(text, head.length)
  }

  /* ② 后备：开头那段在紧后面又原样出现一次。代码块里有 ``` 不猜（代码重复正常）；
     超长正文不扫（逐个 k 试，几万字上是无谓开销，而重试的半截总在开头几百字内） */
  if (text.includes('```') || t.length > 8000) return text
  const half = Math.floor(t.length / 2)
  for (let k = 16; k <= half; k += 1) {
    if (t.startsWith(t.slice(0, k), k)) return cutByTightPrefix(text, k)
  }
  return text
}

/** 从原文里切掉开头 `count` 个**非空白**字符（用 tight 判位、切在原文上，保住排版与代码块） */
function cutByTightPrefix(text: string, count: number): string {
  let seen = 0
  for (let i = 0; i < text.length; i += 1) {
    if (/\s/.test(text[i])) continue
    seen += 1
    if (seen > count) return text.slice(i).trim()
  }
  return ''
}

/**
 * 把 done 带来的汇总全文对齐到已有的轮次上。
 *
 * @param rounds 流式过程中累积的轮次（**不改入参**，返回新数组）
 * @param finalContent done 事件里的汇总全文（空串 = 这次不采用，原样返回）
 * @returns 对齐后的轮次（只在第 6 条会变长，且最多 +1）
 */
export function reconcileFinalRounds(
  rounds: readonly MessageRound[],
  finalContent: string,
): MessageRound[] {
  const next = rounds.map((round) => ({ ...round, tools: [...round.tools] }))
  /* 同一轮内部 / 跨轮把同一个长行说两遍的地方先折成一次（真机第三种形状） */
  for (let i = 0; i < next.length; i += 1) {
    const before = String(next[i].content ?? '')
    const deduped = dropRepeatedLines(foldRestart(before, finalContent))
    if (deduped !== before) next[i] = { ...next[i], content: deduped }
  }
  const text = dropRepeatedLines(String(finalContent ?? ''))
  if (!text) return next /* 1 */

  /* 2：最后写的就是这段（协作汇报 / 普通单轮最常见的收尾） */
  const lastIndex = next.length - 1
  if (lastIndex >= 0 && String(next[lastIndex].content ?? '') === text) return next

  const spliced = next.map((round) => String(round.content ?? '')).join('')
  const a = tight(spliced)
  const b = tight(text)

  /* 3：忽略空白后完全一样 —— 用户报的「整段来两遍」正是走到了这里以前的分支 */
  if (a === b) return next

  /* 找最后一个「有正文」的轮次 */
  let lastWith = -1
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (String(next[i].content ?? '').trim()) {
      lastWith = i
      break
    }
  }

  /* 4：一条正文轮都没有（整轮只有思考 / 工具）—— 填进去，不新建 */
  if (lastWith < 0) {
    if (next.length === 0) return [{ reasoning: '', content: text, tools: [] }]
    next[next.length - 1] = { ...next[next.length - 1], content: text }
    return next
  }

  /* 5：高度重合 → 同一份的两种长度。final 更长就把多出来的补在最后那条正文轮上 */
  if (a.length > 0 && b.length > 0 && coverage(a, b) >= 0.9) {
    if (b.length <= a.length) return next /* 已有的更全，别用短的盖掉 */
    /*
     * ★ 2026-10-21 第三次修（真机抓到的）：这里以前用「前面各轮的正文」当锚点。
     *   只有**一条**正文轮时那个锚点是空串，`text.startsWith('')` 恒真 →
     *   `tail = 全文`，于是整份 final 盖进那一轮：里面若复述了刚显示的那段，
     *   屏幕上就是「正文 → ## 总结 → 同一段再来一遍」（真机 keyTimes=2）。
     *
     *   现在分两种：
     *     · final 以**已显示全文**开头 → 只把多出来的部分接在最后一轮后面
     *       （保住每轮的分段排版），且新增部分里凡是「整行都已显示过」的都剥掉
     *       （复述不再排第二遍）；
     *     · 前缀对不上（收尾复核改了中间一个字 / 一个乱码字符）→ 以 final 为准：
     *       前面各轮的**正文**让位，思考与工具一条不动（过程照样看得见）。
     *       （2026-10-21 第二次修：187 轮那条真实消息前 186 轮 + 全文。）
     */
    if (text.startsWith(spliced)) {
      const added = stripShown(text.slice(spliced.length), a, true)
      if (!added.trim()) return next
      next[lastWith] = {
        ...next[lastWith],
        content: String(next[lastWith].content ?? '') + added,
      }
      return next
    }
    for (let i = 0; i < lastWith; i += 1) next[i] = { ...next[i], content: '' }
    next[lastWith] = { ...next[lastWith], content: text }
    return next
  }

  /*
   * 6：是另外一段话（协作汇报 / 换了说法）—— 新增一轮。
   * 但先把「已经显示过的那几段」剥掉：总结复述过程时，复述本身不能再排一遍。
   * 剥完一个字不剩 → 整份都是复述，原样返回（不新增空轮）。
   */
  const rest = stripShown(text, a)
  if (!rest.trim()) return next
  next.push({ reasoning: '', content: rest, tools: [] })
  return next
}
