/* ══════════════════════════════════════════════════════════════
   高亮：类型

   语言表（specs.ts）给的是「人类好写」的松散定义，resolve 之后
   变成这里的 ResolvedSpec（关键字装成 Set、大小写统一）。

   拆成目录是因为原来的 highlight.ts 已经顶到 200 行，
   再加 30 种语言必定超 300 行的硬上限。
   ══════════════════════════════════════════════════════════════ */

export type TokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'function'
  | 'type'
  | 'tag'
  | 'attribute'
  | 'property'
  | 'operator'
  | 'punctuation'
  | 'constant'
  | 'regex'
  | 'variable'
  | 'addition'
  | 'deletion'
  | 'meta'

export interface Token {
  kind: TokenKind
  text: string
}

/**
 * 语言特性开关。tokenizer 按这些开关切换扫描行为。
 *
 * 刻意做成「一堆布尔开关」而不是继承体系 —— 语言之间的差异
 * 是零散的（Go 没有三引号但有反引号，YAML 只认 key: value），
 * 用继承会写出一个谁都不像的基类。
 */
export type Feature =
  /** C 系 `#include`、R 的 `#!` 这类整行指令 */
  | 'preprocessor'
  /** `@Override` / `@decorator` */
  | 'annotation'
  /** HTML/XML 标签模式 */
  | 'tag'
  /** `key: value` / `key = value` 逐行模式（YAML / TOML / INI） */
  | 'keyValue'
  /** CSS 的 `选择器 { 属性: 值 }` 模式 */
  | 'css'
  /** Markdown 自身的轻量着色 */
  | 'markdown'
  /** 逐行 `+` / `-` 模式（diff） */
  | 'diff'
  /** Python 的 `"""..."""` */
  | 'tripleQuote'
  /** JS 的 `/pattern/flags` 字面量 */
  | 'regex'
  /** SQL 那种大小写不敏感的语言 */
  | 'caseInsensitive'
  /** 引号内不做转义（SQL 用 '' 表示单引号） */
  | 'doubleQuoteEscape'
  /** 字符串可以跨行（反引号、三重引号外的普通串一般不行） */
  | 'multilineString'

/** 语言表里手写的松散定义 */
export interface LanguageSpec {
  id: string
  name: string
  aliases?: string[]
  keywords?: string[]
  types?: string[]
  constants?: string[]
  lineComment?: string[]
  blockComment?: [string, string]
  quotes?: string
  features?: Feature[]
}

/** 查表用的规范化结果 */
export interface ResolvedSpec {
  id: string
  name: string
  keywords: Set<string>
  types: Set<string>
  constants: Set<string>
  lineComment: string[]
  blockComment?: [string, string]
  quotes: string
  features: Feature[]
  caseInsensitive: boolean
}
