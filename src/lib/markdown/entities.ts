/* ══════════════════════════════════════════════════════════════
   HTML 实体解码（Phase 3 对拍补的高频缺口）

   CommonMark/GFM 里 `&amp;` / `&lt;` / `&#39;` 要还原成字符。本解析器以前
   原样透传 —— 模型偶尔会写 `&amp;`，界面上就直接露出「&amp;」，读着像 bug。
   对拍（`__tests__/gfm-gap.test.ts`）把这条量成唯一一个「**显示错误**」类的
   高频缺口，所以补上；其余（setext、缩进代码块、`<url>` autolink、相对链接）
   是「降级成纯文本」，记为已知差异。

   ★ 只解**一次**（不递归）：`&amp;amp;` 应还原成 `&amp;`，不是 `&`。
   ★ 只作用于**普通文字**（`parseInline` 里的 text 节点）：行内代码、原始 HTML、
     链接目标都绕过这里，所以 `&lt;script&gt;` 被还原后也只是**文本**，
     React 渲染时会转义，不会执行。

   单独一个文件是因为 `inline.ts` 已经贴着 300 行红线（AGENT.md 第 2 条）。
   ══════════════════════════════════════════════════════════════ */

/** 常见命名实体（CommonMark 认全表 ~200 个；这里收最常用的一批） */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  plusmn: '±',
  deg: '°',
  middot: '·',
  bull: '•',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  larr: '←',
  rarr: '→',
  harr: '↔',
  ne: '≠',
  le: '≤',
  ge: '≥',
}

/** `&amp;` / `&#39;` / `&#x27;` → 字符；不认识的原样留着 */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(
    /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (whole, body: string) => {
      if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X'
        const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
        try {
          return String.fromCodePoint(code)
        } catch {
          return whole
        }
      }
      return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole
    },
  )
}
