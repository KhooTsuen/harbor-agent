/* ══════════════════════════════════════════════════════════════
   流式：未闭合的**跨行块**降级为纯文本（Phase 3）

   问题：`$$` 开了还没闭合时，`blocks-special.ts` 的 `trySpecialBlock`
   会「吃到末尾、先当公式块渲染」。流式期间这意味着**整段正文被吞进
   KaTeX**，等闭合那一刻再吐出来 —— 看着就是「一大块内容来回变」。

   做法：扫一遍尾巴全文，找出**最后一个未闭合的跨行块**（围栏 ```/~~~、
   公式定界 `$$`），从它的行首起整段当**纯文本**渲染；闭合之后（下次扫描
   fence 状态回到 false）自然升级回块。

   ── 三条纪律 ──

   1. **只作用于尾巴**（`StreamingMarkdown` 的 `TailBlock`）。未闭合块永远
      留在尾巴里：`incremental.ts` 的 `findStablePoint` 在围栏内**不产生切点**，
      所以稳定块（`StableBlocks`，靠「数组 / 节点引用不变」memo）里永远不含
      未闭合块 —— **引用不变策略不受任何影响**。
   2. **闭合才升级**。fence 只在扫到闭合标记时才翻回，所以升级恰好发生在
      「结构真的完整了」那一刻，不是靠猜。
   3. **写入侧的整篇解析（`Markdown.tsx`）不参与**。写完的消息照旧按
      CommonMark 语义渲染（未闭合围栏到文档末尾仍是一个 code block）——
      本文件只管「流式途中别横跳」。

   ★ 与 `pending.ts` 的分工：那边管**最后一行**的残缺标记（`-`、`##`），
     本文件管**跨行的未闭合**。`TailBlock` 里先本文件、再那边。
   ══════════════════════════════════════════════════════════════ */

/* 围栏（``` / ~~~，可带语言）—— 与 `incremental.ts` 同一套判定口径 */
const RE_FENCE = /^(\s*)(`{3,}|~{3,})/
/* 公式定界：只有「整行就是 $$」才 toggle（`$$x$$` 单行块不算，否则状态会乱） */
const RE_MATH_FENCE = /^\s*\$\$\s*$/

/**
 * 把文本拆成「已闭合、可正常解析的部分」和「末尾那个未闭合块（当纯文本）」。
 *
 * 没有未闭合块时 `unclosed` 为空串，行为与改动前完全一致。
 */
export function splitUnclosedBlock(text: string): { settled: string; unclosed: string } {
  let i = 0
  let fence = false
  /** 进入当前未闭合块时的行首偏移（-1 = 不在块里） */
  let openAt = -1

  while (i < text.length) {
    const nl = text.indexOf('\n', i)
    const end = nl === -1 ? text.length : nl
    const line = text.slice(i, end)
    if (RE_FENCE.test(line) || RE_MATH_FENCE.test(line)) {
      fence = !fence
      openAt = fence ? i : -1
    }
    if (nl === -1) break
    i = nl + 1
  }

  if (fence && openAt >= 0) {
    return { settled: text.slice(0, openAt), unclosed: text.slice(openAt) }
  }
  return { settled: text, unclosed: '' }
}
