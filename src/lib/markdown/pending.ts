/* ══════════════════════════════════════════════════════════════
   尾巴里那「半行」怎么处理（AG-022）

   流式时最后一行多半还没写完。如果把它也丢进 Markdown 解析，它会先被
   当成一种块、写完又变成另一种 —— 就是用户说的「写完一段被覆盖重写」。

   但也不能**凡最后一行都降级成纯文本**：`## 标题` 写完的那一刻就已经是
   标题了，`- 甲` 也已经是列表项，下一行再来 `- 乙` 不会让它变样。
   只有「光杆/半截」的标记，现在解析才会得到**错误**的块类型。

   所以规则是：**完整的一行照常解析，只有残缺的标记行降级成纯文本**。
   ══════════════════════════════════════════════════════════════ */

/** 这一行是不是「还没写完的块标记」 */
export function isIncompleteLine(line: string): boolean {
  /* 光杆列表标记：`-` `*` `+`（后面没内容，或只有空任务框） */
  if (/^\s*[-*+]\s*$/.test(line)) return true
  if (/^\s*[-*+]\s+\[[ xX]?\]\s*$/.test(line)) return true
  if (/^\s*\d{1,9}[.)]\s*$/.test(line)) return true
  /* 围栏开头（还没内容、还没闭合）：``` 或 ```ts 或 ~~~ */
  if (/^\s*(`{3,}|~{3,})\s*[^\s`~]*$/.test(line)) return true
  /* 光杆标题：##（井号后没文字） */
  if (/^\s*#{1,6}\s*$/.test(line)) return true
  /*
   * 表格行：**开头是 |、但还不成形状**才算残缺（`|`、`| A`）。
   *
   * 完整的表格行（至少两个 `|`、且以 `|` 收尾，如 `| A |` / `| 1 | 2 |`）
   * 照常解析 —— 否则数据行会一直停在纯文本里，流式期间永远长不进表格，
   * 只能等写完才「啪」一下出现。
   * 从残缺到完整只会跨过一次（追加式流式不会来回），所以不会横跳。
   */
  if (/^\s*\|/.test(line)) {
    const pipes = (line.match(/\|/g) ?? []).length
    if (pipes < 2 || !/\|\s*$/.test(line)) return true
  }
  /* 光杆引用 > */
  if (/^\s*>\s*$/.test(line)) return true
  return false
}

/**
 * 把尾巴拆成「已经能解析的部分」和「还在写的残缺行」。
 *
 * - `settled`：完整行，交给 Markdown 解析（进块渲染）
 * - `pending`：残缺标记行，当纯文本渲染
 */
export function splitPendingLine(text: string): { settled: string; pending: string } {
  const nl = text.lastIndexOf('\n')
  if (nl === -1) {
    /* 只有一行：残缺才拆，完整就直接解析 */
    return isIncompleteLine(text) ? { settled: '', pending: text } : { settled: text, pending: '' }
  }
  const last = text.slice(nl + 1)
  if (isIncompleteLine(last)) {
    return { settled: text.slice(0, nl + 1), pending: last }
  }
  return { settled: text, pending: '' }
}
