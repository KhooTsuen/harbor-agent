import type { ResolvedSpec, Token, TokenKind } from './types'

/* ══════════════════════════════════════════════════════════════
   主扫描器

   逐字符走，不用一次性大正则 —— 一次性正则处理不了
   「字符串里的注释符」「正则里的斜杠」这类嵌套，会出现大片误染。

   流式安全：字符串/注释没闭合时，扫到文档末尾就停，不会吞掉后面的内容。
   ══════════════════════════════════════════════════════════════ */

/** 标识符首字符（放开到非 ASCII，中文/西里尔变量名不会被拆坏） */
const ID_START = /[A-Za-z_$\u00aa-\uffff]/
const ID_PART = /[A-Za-z0-9_$\u00aa-\uffff]/

/** 0x / 0b / 0o / 小数 / 指数 / 下划线分隔 / 常见类型后缀 */
const NUMBER =
  /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)(?:[a-zA-Z_]\w*)?/

const OPERATORS = /^[+\-*/%=<>!&|^~?:@]+/
const PUNCTUATION = /^[()[\]{},;.]+/

/** 这些符号之后，`/` 是正则字面量而不是除号 */
const REGEX_AFTER = new Set([
  '',
  '=',
  '(',
  ',',
  '[',
  '{',
  ';',
  ':',
  '!',
  '&',
  '|',
  '?',
  '+',
  '-',
  '*',
  '%',
  '^',
  '~',
  '<',
  '>',
])
/** 这些关键字之后同理 */
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
])

/**
 * 读一个字符串字面量。
 *
 * 返回截取长度而不是下标，调用方 `i += length` 就行。
 * 没闭合时读到文档末尾 —— 流式输出到一半就是这种状态。
 */
export function readString(
  code: string,
  start: number,
  quote: string,
  triple: boolean,
  spec: ResolvedSpec,
): { text: string; length: number } {
  const doubleEscape = spec.features.includes('doubleQuoteEscape')
  const multiline =
    triple || quote === '`' || spec.features.includes('multilineString') || spec.id === 'json'
  const size = triple ? 3 : 1
  let i = start + size

  while (i < code.length) {
    const ch = code[i]

    if (ch === '\\' && !doubleEscape) {
      i += 2
      continue
    }

    if (ch === quote) {
      if (triple) {
        if (code.startsWith(quote.repeat(3), i)) {
          i += 3
          break
        }
        i += 1
        continue
      }
      /* SQL 用 '' 表示一个单引号 */
      if (doubleEscape && code[i + 1] === quote) {
        i += 2
        continue
      }
      i += 1
      break
    }

    if (ch === '\n' && !multiline) break
    i += 1
  }

  return { text: code.slice(start, i), length: i - start }
}

function canStartRegex(prevChar: string, prevWord: string): boolean {
  if (prevWord && REGEX_AFTER_WORD.has(prevWord)) return true
  return REGEX_AFTER.has(prevChar)
}

export function tokenizeCode(code: string, spec: ResolvedSpec): Token[] {
  const out: Token[] = []
  let buf = ''
  let i = 0
  let atLineStart = true
  let prevChar = ''
  let prevWord = ''

  const flush = (): void => {
    if (buf) {
      out.push({ kind: 'plain', text: buf })
      buf = ''
    }
  }
  const push = (kind: TokenKind, text: string): void => {
    flush()
    out.push({ kind, text })
  }
  const lower = (word: string): string => (spec.caseInsensitive ? word.toLowerCase() : word)

  while (i < code.length) {
    const ch = code[i]

    /* 行首状态：只有换行和空白会保持它 */
    if (ch === '\n') {
      buf += ch
      i += 1
      atLineStart = true
      prevChar = ''
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      buf += ch
      i += 1
      continue
    }

    const rest = code.slice(i)

    /* 行首指令：C 的 #include、Makefile 的 include 之类。
       注意 shell / PowerShell 的 # 本身就是行注释，不能抢 —— 只有
       行注释里不含 # 的语言才把行首 # 当指令。 */
    if (
      atLineStart &&
      ch === '#' &&
      spec.features.includes('preprocessor') &&
      !spec.lineComment.includes('#')
    ) {
      const end = code.indexOf('\n', i)
      const stop = end === -1 ? code.length : end
      push('meta', code.slice(i, stop))
      i = stop
      atLineStart = false
      prevChar = '#'
      continue
    }
    atLineStart = false

    /* 行注释 */
    const lineMark = spec.lineComment.find((mark) => rest.startsWith(mark))
    if (lineMark) {
      const end = code.indexOf('\n', i)
      const stop = end === -1 ? code.length : end
      push('comment', code.slice(i, stop))
      i = stop
      prevChar = ''
      prevWord = ''
      continue
    }

    /* 块注释 */
    if (spec.blockComment && rest.startsWith(spec.blockComment[0])) {
      const [open, close] = spec.blockComment
      const end = code.indexOf(close, i + open.length)
      const stop = end === -1 ? code.length : end + close.length
      push('comment', code.slice(i, stop))
      i = stop
      prevChar = ''
      prevWord = ''
      continue
    }

    /* 注解 @Foo */
    if (ch === '@' && spec.features.includes('annotation') && ID_START.test(code[i + 1] ?? '')) {
      const match = /^@[\w$.]+/.exec(rest)
      if (match) {
        push('meta', match[0])
        i += match[0].length
        prevChar = ''
        prevWord = ''
        continue
      }
    }

    /* 字符串 */
    if (spec.quotes.includes(ch)) {
      const triple = spec.features.includes('tripleQuote') && rest.startsWith(ch.repeat(3))
      const { text, length } = readString(code, i, ch, triple, spec)
      push('string', text)
      i += length
      prevChar = '"'
      prevWord = ''
      continue
    }

    /* 正则字面量 */
    if (ch === '/' && spec.features.includes('regex') && canStartRegex(prevChar, prevWord)) {
      const match = /^\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+\/[gimsuy]*/.exec(rest)
      if (match) {
        push('regex', match[0])
        i += match[0].length
        prevChar = '/'
        prevWord = ''
        continue
      }
    }

    /* 数字（先确认是数字开头，免得把单独的 `.` 当数字读了） */
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(code[i + 1] ?? ''))) {
      const match = NUMBER.exec(rest)
      if (match?.[0]) {
        push('number', match[0])
        i += match[0].length
        prevChar = match[0].slice(-1)
        prevWord = ''
        continue
      }
    }

    /* 标识符 */
    if (ID_START.test(ch)) {
      let j = i + 1
      while (j < code.length && ID_PART.test(code[j])) j += 1
      const word = code.slice(i, j)
      const key = lower(word)

      let kind: TokenKind = 'plain'
      if (spec.keywords.has(key)) kind = 'keyword'
      else if (spec.constants.has(key)) kind = 'constant'
      else if (spec.types.has(key)) kind = 'type'
      else if (/^\s*\(/.test(code.slice(j))) kind = 'function'
      else if (prevChar === '.' && /^[a-z]/.test(word)) kind = 'property'
      else if (/^[A-Z]/.test(word)) kind = 'type'

      if (kind === 'plain') buf += word
      else push(kind, word)

      i = j
      prevChar = 'w'
      prevWord = word
      continue
    }

    /* 运算符与标点 */
    const operator = OPERATORS.exec(rest)
    if (operator) {
      push('operator', operator[0])
      i += operator[0].length
      prevChar = operator[0].slice(-1)
      prevWord = ''
      continue
    }
    const punctuation = PUNCTUATION.exec(rest)
    if (punctuation) {
      push('punctuation', punctuation[0])
      i += punctuation[0].length
      prevChar = punctuation[0].slice(-1)
      prevWord = ''
      continue
    }

    buf += ch
    i += 1
  }

  flush()
  return out
}
