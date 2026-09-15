import type { LanguageSpec } from './types'
import * as K from './keywords'
import { CURLY } from './specs'

/* ══════════════════════════════════════════════════════════════
   语言表（二）：Shell / 数据配置 / 标记 / 样式 / 差异 / 兜底

   和 specs.ts 分开纯粹是因为两张表加起来超过 300 行的硬上限。
   这种纯数据文件按族拆比硬塞成一张表好读。
   ══════════════════════════════════════════════════════════════ */

export const EXTRA_SPECS: LanguageSpec[] = [
  /* ── Shell ── */
  {
    id: 'shell',
    name: 'Shell',
    aliases: ['sh', 'bash', 'zsh', 'shell', 'console', 'shellsession', 'fish', 'ksh'],
    keywords: K.SH,
    constants: K.CONSTANTS,
    lineComment: ['#'],
    quotes: '"\'`',
    features: ['preprocessor'],
  },
  {
    id: 'powershell',
    name: 'PowerShell',
    aliases: ['ps1', 'ps', 'pwsh'],
    keywords: K.PS,
    constants: K.CONSTANTS,
    lineComment: ['#'],
    blockComment: ['<#', '#>'],
    quotes: '"\'`',
    features: ['caseInsensitive', 'preprocessor'],
  },

  /* ── 数据 / 配置 ── */
  {
    id: 'sql',
    name: 'SQL',
    keywords: K.SQL,
    constants: K.CONSTANTS,
    lineComment: ['--'],
    blockComment: ['/*', '*/'],
    quotes: '"\'`',
    features: ['caseInsensitive', 'doubleQuoteEscape'],
  },
  {
    id: 'json',
    name: 'JSON',
    aliases: ['jsonc', 'geojson'],
    constants: K.CONSTANTS,
    quotes: '"',
  },
  {
    id: 'json5',
    name: 'JSON5',
    aliases: ['json5c'],
    constants: K.CONSTANTS,
    ...CURLY,
    quotes: '"\'',
  },
  {
    id: 'yaml',
    name: 'YAML',
    aliases: ['yml'],
    constants: K.CONSTANTS,
    lineComment: ['#'],
    quotes: '"\'',
    features: ['keyValue'],
  },
  {
    id: 'toml',
    name: 'TOML',
    constants: K.CONSTANTS,
    lineComment: ['#'],
    quotes: '"\'',
    features: ['keyValue'],
  },
  {
    id: 'ini',
    name: 'INI',
    aliases: ['cfg', 'conf', 'properties', 'env', 'dotenv'],
    constants: K.CONSTANTS,
    lineComment: [';', '#'],
    quotes: '"\'',
    features: ['keyValue'],
  },
  {
    id: 'dockerfile',
    name: 'Dockerfile',
    aliases: ['docker'],
    keywords: K.DOCKER,
    constants: K.CONSTANTS,
    lineComment: ['#'],
    quotes: '"\'',
    features: ['caseInsensitive'],
  },
  {
    id: 'makefile',
    name: 'Makefile',
    aliases: ['make', 'mk'],
    keywords: K.MAKE,
    lineComment: ['#'],
    quotes: '"\'',
  },

  /* ── 标记 / 样式 ── */
  {
    id: 'html',
    name: 'HTML',
    aliases: ['htm'],
    blockComment: ['<!--', '-->'],
    quotes: '"\'',
    features: ['tag'],
  },
  {
    id: 'xml',
    name: 'XML',
    aliases: ['svg', 'xsl', 'xslt', 'plist', 'rss'],
    blockComment: ['<!--', '-->'],
    quotes: '"\'',
    features: ['tag'],
  },
  {
    id: 'vue',
    name: 'Vue',
    blockComment: ['<!--', '-->'],
    quotes: '"\'',
    features: ['tag'],
  },
  {
    id: 'svelte',
    name: 'Svelte',
    blockComment: ['<!--', '-->'],
    quotes: '"\'',
    features: ['tag'],
  },
  {
    id: 'css',
    name: 'CSS',
    blockComment: ['/*', '*/'],
    quotes: '"\'',
    features: ['css'],
  },
  {
    id: 'scss',
    name: 'SCSS',
    aliases: ['sass'],
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    quotes: '"\'',
    features: ['css'],
  },
  {
    id: 'less',
    name: 'Less',
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    quotes: '"\'',
    features: ['css'],
  },
  {
    id: 'markdown',
    name: 'Markdown',
    aliases: ['md', 'mdx'],
    features: ['markdown'],
  },

  /* ── 差异 ── */
  {
    id: 'diff',
    name: 'Diff',
    aliases: ['patch'],
    features: ['diff'],
  },

  /* ── 兜底 ── */
  {
    id: 'plaintext',
    name: 'Text',
    aliases: ['text', 'txt', 'plain', 'log', 'output', 'ansi', 'csv', 'tsv'],
  },
]
