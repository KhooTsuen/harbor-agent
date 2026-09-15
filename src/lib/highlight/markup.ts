import type { ResolvedSpec, Token, TokenKind } from './types'
import { getLanguage } from './resolve'
import { readString, tokenizeCode } from './tokenizer'
import { tokenizeCss } from './styles'

/* ══════════════════════════════════════════════════════════════
   标记语言（HTML / XML / Vue / Svelte）

   `<script>` 和 `<style>` 的内容交给对应语言的 tokenizer ——
   一个 .vue 文件里三种语言混着写，只靠一套规则染不出来。
   ══════════════════════════════════════════════════════════════ */

const RE_TAG_NAME = /^[A-Za-z][\w:.-]*/
const RE_ATTR_NAME = /^[A-Za-z_:@#[\]().-][\w:.-]*/

export function tokenizeMarkup(code: string, spec: ResolvedSpec): Token[] {
  const out: Token[] = []
  let buf = ''
  let i = 0

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

  const commentOpen = spec.blockComment?.[0] ?? '<!--'
  const commentClose = spec.blockComment?.[1] ?? '-->'

  while (i < code.length) {
    const rest = code.slice(i)

    /* <!-- 注释 --> */
    if (rest.startsWith(commentOpen)) {
      const end = code.indexOf(commentClose, i + commentOpen.length)
      const stop = end === -1 ? code.length : end + commentClose.length
      push('comment', code.slice(i, stop))
      i = stop
      continue
    }

    /* <!DOCTYPE ...> */
    if (rest.startsWith('<!')) {
      const end = code.indexOf('>', i)
      const stop = end === -1 ? code.length : end + 1
      push('meta', code.slice(i, stop))
      i = stop
      continue
    }

    /* &nbsp; &#160; */
    if (rest.startsWith('&')) {
      const match = /^&(?:#\d+|#x[\da-fA-F]+|\w+);/.exec(rest)
      if (match) {
        push('constant', match[0])
        i += match[0].length
        continue
      }
    }

    if (code[i] === '<') {
      let j = i + 1
      let closing = false
      if (code[j] === '/') {
        closing = true
        j += 1
      }

      const name = RE_TAG_NAME.exec(code.slice(j))
      if (!name) {
        /* 光杆小于号（比如数学里的 a < b），当普通文字 */
        buf += code[i]
        i += 1
        continue
      }

      push('punctuation', code.slice(i, j))
      push('tag', name[0])
      j += name[0].length

      /* 属性区 */
      while (j < code.length && code[j] !== '>' && !code.startsWith('/>', j)) {
        const ch = code[j]
        if (ch === '"' || ch === "'") {
          const { text, length } = readString(code, j, ch, false, spec)
          push('string', text)
          j += length
          continue
        }
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
          buf += ch
          j += 1
          continue
        }
        if (ch === '=') {
          push('operator', ch)
          j += 1
          continue
        }
        const attr = RE_ATTR_NAME.exec(code.slice(j))
        if (attr) {
          push('attribute', attr[0])
          j += attr[0].length
          continue
        }
        buf += ch
        j += 1
      }

      if (code.startsWith('/>', j)) {
        push('punctuation', '/>')
        j += 2
      } else if (code[j] === '>') {
        push('punctuation', '>')
        j += 1
      }
      i = j

      /* 内嵌的 script / style：换语言接着染 */
      const tag = name[0].toLowerCase()
      if (!closing && (tag === 'script' || tag === 'style')) {
        const at = code.slice(i).search(new RegExp(`</${tag}`, 'i'))
        if (at > 0) {
          const inner = code.slice(i, i + at)
          const innerSpec = getLanguage(tag === 'script' ? 'js' : 'css')
          if (innerSpec) {
            out.push(
              ...(tag === 'script'
                ? tokenizeCode(inner, innerSpec)
                : tokenizeCss(inner, innerSpec)),
            )
          } else {
            out.push({ kind: 'plain', text: inner })
          }
          i += at
        }
      }
      continue
    }

    buf += code[i]
    i += 1
  }

  flush()
  return out
}
