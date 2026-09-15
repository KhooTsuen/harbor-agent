import type { LanguageSpec } from './types'
import * as K from './keywords'

/* ══════════════════════════════════════════════════════════════
   语言表

   语言表（一）：脚本语言 + 系统语言。数据/配置/标记语言在 specs-extra.ts。
   aliases 是**代码块围栏上真正可能出现的写法**
   （```ts / ```bash / ```console 都得认）。

   写不下的都归到最接近的族里 —— 比如 vue 走 tag、scss 走 css。
   ══════════════════════════════════════════════════════════════ */

/** C 系三件套：// 行注释、斜杠星块注释。另一个语言表文件也要用 */
export const CURLY: Pick<LanguageSpec, 'lineComment' | 'blockComment'> = {
  lineComment: ['//'],
  blockComment: ['/*', '*/'],
}

export const SPECS: LanguageSpec[] = [
  /* ── JS / TS ── */
  {
    id: 'typescript',
    name: 'TypeScript',
    aliases: ['ts', 'tsx', 'mts', 'cts'],
    keywords: K.JS,
    types: K.JS_TYPES,
    constants: K.CONSTANTS,
    ...CURLY,
    quotes: '"\'`',
    features: ['regex', 'annotation'],
  },
  {
    id: 'javascript',
    name: 'JavaScript',
    aliases: ['js', 'jsx', 'mjs', 'cjs', 'node'],
    keywords: K.JS,
    types: K.JS_TYPES,
    constants: K.CONSTANTS,
    ...CURLY,
    quotes: '"\'`',
    features: ['regex'],
  },

  /* ── 脚本 ── */
  {
    id: 'python',
    name: 'Python',
    aliases: ['py', 'python3'],
    keywords: K.PY,
    types: K.PY_TYPES,
    constants: K.CONSTANTS,
    lineComment: ['#'],
    quotes: '"\'',
    features: ['tripleQuote', 'annotation'],
  },
  {
    id: 'ruby',
    name: 'Ruby',
    aliases: ['rb'],
    keywords: K.RB,
    constants: K.CONSTANTS,
    lineComment: ['#'],
    quotes: '"\'`',
  },
  {
    id: 'lua',
    name: 'Lua',
    keywords: K.LUA,
    constants: K.CONSTANTS,
    lineComment: ['--'],
    blockComment: ['--[[', ']]'],
    quotes: '"\'',
  },
  {
    id: 'r',
    name: 'R',
    aliases: ['rscript'],
    keywords: K.R,
    constants: K.CONSTANTS,
    lineComment: ['#'],
    quotes: '"\'',
  },
  {
    id: 'php',
    name: 'PHP',
    keywords: K.PHP,
    types: K.KS_TYPES,
    constants: K.CONSTANTS,
    lineComment: ['//', '#'],
    blockComment: ['/*', '*/'],
    quotes: '"\'`',
  },

  /* ── 系统语言 ── */
  {
    id: 'rust',
    name: 'Rust',
    aliases: ['rs'],
    keywords: K.RS,
    types: K.RS_TYPES,
    constants: K.CONSTANTS,
    ...CURLY,
    quotes: '"\'',
    features: ['annotation'],
  },
  {
    id: 'go',
    name: 'Go',
    aliases: ['golang'],
    keywords: K.GO,
    types: K.GO_TYPES,
    constants: K.CONSTANTS,
    ...CURLY,
    quotes: '"\'`',
  },
  {
    id: 'c',
    name: 'C',
    aliases: ['h'],
    keywords: K.C,
    types: K.SYS_TYPES,
    constants: K.CONSTANTS,
    ...CURLY,
    quotes: '"\'',
    features: ['preprocessor'],
  },
  {
    id: 'cpp',
    name: 'C++',
    aliases: ['c++', 'cc', 'cxx', 'hpp', 'hxx'],
    keywords: K.CPP,
    types: K.SYS_TYPES,
    constants: K.CONSTANTS,
    ...CURLY,
    quotes: '"\'',
    features: ['preprocessor'],
  },
  {
    id: 'csharp',
    name: 'C#',
    aliases: ['cs', 'c#', 'dotnet'],
    keywords: K.CS,
    types: K.KS_TYPES,
    constants: K.CONSTANTS,
    ...CURLY,
    quotes: '"\'',
    features: ['preprocessor'],
  },
  {
    id: 'java',
    name: 'Java',
    keywords: K.JAVA,
    types: K.KS_TYPES,
    constants: K.CONSTANTS,
    ...CURLY,
    quotes: '"\'',
    features: ['annotation'],
  },
  {
    id: 'kotlin',
    name: 'Kotlin',
    aliases: ['kt', 'kts'],
    keywords: K.KOTLIN,
    types: K.KS_TYPES,
    constants: K.CONSTANTS,
    ...CURLY,
    quotes: '"\'`',
    features: ['annotation'],
  },
  {
    id: 'swift',
    name: 'Swift',
    keywords: K.SWIFT,
    types: K.KS_TYPES,
    constants: K.CONSTANTS,
    ...CURLY,
    quotes: '"\'',
    features: ['annotation'],
  },
]
