import type { ResolvedSpec, Token, TokenKind } from './types'
import { readString } from './tokenizer'

/* ══════════════════════════════════════════════════════════════
   特殊模式（二）：CSS / Markdown

   从 data.ts 拆出来的 —— 那边加上这两块会过 300 行。
   ══════════════════════════════════════════════════════════════ */

/* ── CSS ──────────────────────────────────────────────────── */

const RE_CSS_NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]{1,4})?/
const RE_CSS_COLOR = /^#[\da-fA-F]{3,8}\b/
const RE_CSS_PROPERTY = /^([-\w]+)(\s*:)(?!:)/

export function tokenizeCss(code: string, spec: ResolvedSpec): Token[] {
  const out: Token[] = []
  let buf = ''
  let i = 0
  let inBlock = false
  let lastSig = ''
  let atLineStart = true

  const flush = (): void => {
    if (buf) {
      out.push({ kind: 'plain', text: buf })
      buf = ''
    }
  }
  const push = (kind: TokenKind, text: string): void => {
    flush()
    out.push({ kind, text })
    lastSig = text.slice(-1)
  }

  while (i < code.length) {
    const rest = code.slice(i)
    const ch = code[i]

    if (ch === '\n') {
      buf += ch
      i += 1
      atLineStart = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      buf += ch
      i += 1
      continue
    }

    if (spec.blockComment && rest.startsWith(spec.blockComment[0])) {
      const [open, close] = spec.blockComment
      const end = code.indexOf(close, i + open.length)
      const stop = end === -1 ? code.length : end + close.length
      push('comment', code.slice(i, stop))
      i = stop
      atLineStart = false
      continue
    }

    const mark = spec.lineComment.find((m) => rest.startsWith(m))
    if (mark) {
      const end = code.indexOf('\n', i)
      const stop = end === -1 ? code.length : end
      push('comment', code.slice(i, stop))
      i = stop
      continue
    }

    if (ch === '"' || ch === "'") {
      const { text, length } = readString(code, i, ch, false, spec)
      push('string', text)
      i += length
      atLineStart = false
      continue
    }

    /* @media / @import */
    if (ch === '@') {
      const match = /^@[\w-]+/.exec(rest)
      if (match) {
        push('meta', match[0])
        i += match[0].length
        atLineStart = false
        continue
      }
    }

    if (ch === '!') {
      const match = /^!\s*important/.exec(rest)
      if (match) {
        push('keyword', match[0])
        i += match[0].length
        atLineStart = false
        continue
      }
    }

    if (ch === '#' && RE_CSS_COLOR.test(rest)) {
      const match = RE_CSS_COLOR.exec(rest)
      if (match) {
        push('number', match[0])
        i += match[0].length
        atLineStart = false
        continue
      }
    }

    /* 属性名：只在 `{` / `;` / 行首之后才认，免得把选择器当属性 */
    if (inBlock && (/[A-Za-z-]/.test(ch) || ch === '_')) {
      const prop = RE_CSS_PROPERTY.exec(rest)
      const fresh = lastSig === '{' || lastSig === ';' || lastSig === '' || atLineStart
      if (prop && fresh) {
        push('property', prop[1])
        push('operator', prop[2])
        i += prop[0].length
        atLineStart = false
        continue
      }
    }

    if (/\d/.test(ch) || (ch === '.' && /\d/.test(code[i + 1] ?? ''))) {
      const match = RE_CSS_NUMBER.exec(rest)
      if (match) {
        push('number', match[0])
        i += match[0].length
        atLineStart = false
        continue
      }
    }

    /* 大小括号：{ 表示进入声明区，} 出来 */
    if (ch === '{' || ch === '}') {
      push('punctuation', ch)
      inBlock = ch === '{'
      i += 1
      atLineStart = false
      continue
    }

    /* 分号/逗号也要单独 push —— 属性名的「是否在声明开头」判断
       靠 lastSig，如果把它们并进 buf，lastSig 就停在值上了，
       后面那个属性名会被当成选择器。 */
    if (ch === ';' || ch === ',' || (ch === ':' && inBlock)) {
      push('punctuation', ch)
      i += 1
      atLineStart = false
      continue
    }

    /* 选择器里的 .class / #id / ::pseudo / :hover */
    if (!inBlock && (ch === '.' || ch === '#' || ch === ':')) {
      const match = /^(::?|\.|#)([-\w]+)/.exec(rest)
      if (match) {
        push('tag', match[0])
        i += match[0].length
        atLineStart = false
        continue
      }
    }

    if (/[-\w]+/.test(ch)) {
      const match = /^[-\w]+/.exec(rest)
      if (match) {
        buf += match[0]
        i += match[0].length
        atLineStart = false
        continue
      }
    }

    buf += ch
    i += 1
    atLineStart = false
  }

  flush()
  return out
}

/* ── Markdown ─────────────────────────────────────────────── */

/** 行内：`code` / **粗** / *斜* / [文字](链接) */
function inlineMd(text: string): Token[] {
  const out: Token[] = []
  const re =
    /(`[^`\n]*`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]*\]\([^)\s]+\))|(~~[^~\n]+~~)/g
  let last = 0
  let match: RegExpExecArray | null

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) out.push({ kind: 'plain', text: text.slice(last, match.index) })
    const [raw, code, bold, italic, link, strike] = match
    if (code) out.push({ kind: 'string', text: code })
    else if (bold) out.push({ kind: 'type', text: bold })
    else if (italic) out.push({ kind: 'property', text: italic })
    else if (link) out.push({ kind: 'tag', text: link })
    else if (strike) out.push({ kind: 'comment', text: strike })
    else out.push({ kind: 'plain', text: raw })
    last = match.index + raw.length
  }

  if (last < text.length) out.push({ kind: 'plain', text: text.slice(last) })
  return out
}

export function tokenizeMarkdown(code: string): Token[] {
  const out: Token[] = []
  let inFence = false

  code.split('\n').forEach((line, index) => {
    if (index > 0) out.push({ kind: 'plain', text: '\n' })

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      out.push({ kind: 'meta', text: line })
      return
    }
    /* 代码块里原样 */
    if (inFence) {
      out.push({ kind: 'string', text: line })
      return
    }
    if (/^#{1,6}\s/.test(line)) {
      out.push({ kind: 'keyword', text: line })
      return
    }
    if (/^\s*>/.test(line)) {
      const marker = /^\s*>+\s?/.exec(line)?.[0] ?? ''
      out.push({ kind: 'comment', text: marker })
      out.push(...inlineMd(line.slice(marker.length)))
      return
    }
    if (/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      const marker = /^\s*(?:[-*+]|\d+[.)])\s/.exec(line)?.[0] ?? ''
      out.push({ kind: 'punctuation', text: marker })
      out.push(...inlineMd(line.slice(marker.length)))
      return
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push({ kind: 'meta', text: line })
      return
    }
    out.push(...inlineMd(line))
  })

  return out
}
