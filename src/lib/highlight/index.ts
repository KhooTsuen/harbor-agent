import type { Token, TokenKind } from './types'
import { getLanguage, isPlain } from './resolve'
import { tokenizeCode } from './tokenizer'
import { tokenizeDiff, tokenizeKeyValue } from './data'
import { tokenizeCss, tokenizeMarkdown } from './styles'
import { tokenizeMarkup } from './markup'

/* ══════════════════════════════════════════════════════════════
   高亮入口

   原来是单文件 `highlight.ts`，加到 30 多种语言后必然超 300 行，
   拆成目录：types / keywords / specs / resolve / tokenizer /
   markup / data，本文件只做「按语言分发」。
   ══════════════════════════════════════════════════════════════ */

export type { Token, TokenKind, Feature, LanguageSpec, ResolvedSpec } from './types'
export { getLanguage, languageName, isPlain } from './resolve'

/** 有没有值得染的东西（纯文本 / 认不出的语言就不用染色） */
export function isHighlightable(language: string): boolean {
  const spec = getLanguage(language)
  return spec !== undefined && !isPlain(spec)
}

/**
 * 把源码切成 token。
 *
 * 按语言特性分发到不同的扫描器 —— 一门语言一个扫描器太奢侈，
 * 但 HTML 和 YAML 也确实没法共用一套规则。
 */
export function tokenize(code: string, language: string): Token[] {
  if (!code) return []
  const spec = getLanguage(language)
  if (!spec || isPlain(spec)) return [{ kind: 'plain', text: code }]

  const { features } = spec
  if (features.includes('diff')) return tokenizeDiff(code)
  if (features.includes('markdown')) return tokenizeMarkdown(code)
  if (features.includes('tag')) return tokenizeMarkup(code, spec)
  if (features.includes('css')) return tokenizeCss(code, spec)
  if (features.includes('keyValue')) return tokenizeKeyValue(code, spec)
  return tokenizeCode(code, spec)
}

/**
 * token → 颜色。
 *
 * 全部走 CSS 变量，所以换主题时高亮自动跟着变。
 * 一共只有 4 个 accent + 2 个语义色可用，同类项只能合并：
 * 类型和数字共用一个黄，标签和关键字共用一个紫 —— 相邻出现的概率低，不打架。
 */
export const TOKEN_COLOR: Record<TokenKind, string> = {
  plain: 'var(--text-primary)',
  comment: 'var(--text-tertiary)',
  string: 'var(--accent-green)',
  number: 'var(--accent-yellow)',
  keyword: 'var(--accent-purple)',
  function: 'var(--accent-blue)',
  type: 'var(--info)',
  tag: 'var(--accent-purple)',
  attribute: 'var(--info)',
  property: 'var(--text-secondary)',
  operator: 'var(--text-secondary)',
  punctuation: 'var(--text-tertiary)',
  constant: 'var(--accent-yellow)',
  regex: 'var(--accent-green)',
  variable: 'var(--text-primary)',
  addition: 'var(--diff-add)',
  deletion: 'var(--diff-remove)',
  meta: 'var(--accent-purple)',
}

/** 需要额外加斜体的 token 类型（注释斜着更好认） */
export const ITALIC_TOKENS: ReadonlySet<TokenKind> = new Set<TokenKind>(['comment'])

/** diff 的整行底色 */
export const TOKEN_LINE_BG: Partial<Record<TokenKind, string>> = {
  addition: 'var(--diff-add-bg)',
  deletion: 'var(--diff-remove-bg)',
}
