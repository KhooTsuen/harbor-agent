import { describe, expect, it } from 'vitest'
import type { Token, TokenKind } from '@/lib/highlight'
import { getLanguage, isHighlightable, languageName, TOKEN_COLOR, tokenize } from '@/lib/highlight'

/* ══════════════════════════════════════════════════════════════
   语法高亮

   不好断言「颜色对不对」，所以断言 token 的**种类序列** ——
   种类对了颜色自然对（颜色只是 kind → CSS 变量的一张表）。
   ══════════════════════════════════════════════════════════════ */

const kinds = (code: string, language: string): TokenKind[] =>
  tokenize(code, language).map((token) => token.kind)

/** 某个 kind 对应的所有文本 */
const textsOf = (tokens: Token[], kind: TokenKind): string[] =>
  tokens.filter((token) => token.kind === kind).map((token) => token.text)

const tokenizeOf = (code: string, language: string): Token[] => tokenize(code, language)

describe('语言表', () => {
  it('认别名', () => {
    for (const [alias, id] of [
      ['ts', 'typescript'],
      ['js', 'javascript'],
      ['py', 'python'],
      ['rs', 'rust'],
      ['golang', 'go'],
      ['yml', 'yaml'],
      ['bash', 'shell'],
      ['ps1', 'powershell'],
      ['cs', 'csharp'],
      ['c++', 'cpp'],
      ['md', 'markdown'],
      ['docker', 'dockerfile'],
    ]) {
      expect(getLanguage(alias)?.id).toBe(id)
    }
  })

  it('围栏上粘了元信息也能认出来', () => {
    expect(getLanguage('ts{1,3}')?.id).toBe('typescript')
  })

  it('不认识的语言返回 undefined', () => {
    expect(getLanguage('brainfuck')).toBeUndefined()
    expect(getLanguage('')).toBeUndefined()
  })

  it('显示名', () => {
    expect(languageName('ts')).toBe('TypeScript')
    expect(languageName('bash')).toBe('Shell')
    expect(languageName('')).toBe('Text')
  })

  it('纯文本不染色', () => {
    expect(isHighlightable('text')).toBe(false)
    expect(isHighlightable('ts')).toBe(true)
  })

  it('每个 token 种类都有颜色', () => {
    const used = [
      'plain',
      'comment',
      'string',
      'number',
      'keyword',
      'function',
      'type',
      'tag',
      'attribute',
      'property',
      'operator',
      'punctuation',
      'constant',
      'regex',
      'variable',
      'addition',
      'deletion',
      'meta',
    ] as const
    for (const kind of used) expect(TOKEN_COLOR[kind]).toBeTruthy()
  })
})

describe('JavaScript / TypeScript', () => {
  it('关键字 / 字符串 / 数字 / 函数名', () => {
    const tokens = tokenizeOf('const a = foo("hi", 42)', 'ts')
    expect(textsOf(tokens, 'keyword')).toContain('const')
    expect(textsOf(tokens, 'string')).toEqual(['"hi"'])
    expect(textsOf(tokens, 'number')).toEqual(['42'])
    expect(textsOf(tokens, 'function')).toEqual(['foo'])
  })

  it('行尾注释', () => {
    expect(textsOf(tokenizeOf('a // 说明', 'js'), 'comment')).toEqual(['// 说明'])
  })

  it('模板字符串跨行不断成两半', () => {
    const tokens = tokenizeOf('const s = `a\nb`', 'js')
    expect(textsOf(tokens, 'string')).toEqual(['`a\nb`'])
  })

  it('正则字面量不被当成除号', () => {
    expect(kinds('const r = /ab+c/gi', 'js')).toContain('regex')
  })

  it('除号仍然是除号', () => {
    const tokens = tokenizeOf('const x = a / b', 'js')
    expect(textsOf(tokens, 'regex')).toEqual([])
  })

  it('属性访问', () => {
    expect(textsOf(tokenizeOf('foo.bar', 'js'), 'property')).toEqual(['bar'])
  })

  it('没闭合的字符串不会吞掉后面的代码', () => {
    const tokens = tokenizeOf('const a = "x\nconst b = 1', 'js')
    /* 字符串到行尾就结束，后面的 const 仍然被认成关键字 */
    expect(textsOf(tokens, 'keyword')).toContain('const')
  })
})

describe('Python', () => {
  it('三引号字符串算一整块', () => {
    const tokens = tokenizeOf('s = """多行\n还是字符串"""', 'py')
    expect(textsOf(tokens, 'string')).toEqual(['"""多行\n还是字符串"""'])
  })

  it('装饰器算 meta', () => {
    expect(textsOf(tokenizeOf('@app.route("/")', 'py'), 'meta')).toEqual(['@app.route'])
  })

  it('# 注释', () => {
    expect(textsOf(tokenizeOf('x = 1  # 说明', 'py'), 'comment')).toEqual(['# 说明'])
  })
})

describe('系统语言', () => {
  it('C 的 #include 算 meta，行尾 # 不算', () => {
    const tokens = tokenizeOf('#include <stdio.h>\nint x = 1;', 'c')
    expect(textsOf(tokens, 'meta')).toEqual(['#include <stdio.h>'])
    expect(textsOf(tokens, 'type')).toContain('int')
  })

  it('Rust 的类型名', () => {
    expect(textsOf(tokenizeOf('let x: Vec<u8> = Vec::new();', 'rs'), 'type')).toContain('Vec')
  })

  it('Go 的反引号原始串', () => {
    expect(textsOf(tokenizeOf('s := `raw`', 'go'), 'string')).toEqual(['`raw`'])
  })

  it('SQL 大小写不敏感 + -- 注释', () => {
    const tokens = tokenizeOf('SELECT * FROM t -- 注释', 'sql')
    expect(textsOf(tokens, 'keyword')).toContain('SELECT')
    expect(textsOf(tokens, 'comment')).toEqual(['-- 注释'])
  })

  it('Shell 的行首 # 是注释', () => {
    expect(textsOf(tokenizeOf('# 说明\nls -la', 'bash'), 'comment')).toEqual(['# 说明'])
  })
})

describe('标记语言', () => {
  it('标签 / 属性 / 属性值', () => {
    const tokens = tokenizeOf('<a href="/x" target="_blank">点</a>', 'html')
    expect(textsOf(tokens, 'tag')).toEqual(['a', 'a'])
    expect(textsOf(tokens, 'attribute')).toContain('href')
    expect(textsOf(tokens, 'string')).toEqual(['"/x"', '"_blank"'])
  })

  it('注释与实体', () => {
    const tokens = tokenizeOf('<!-- c -->&nbsp;', 'html')
    expect(textsOf(tokens, 'comment')).toEqual(['<!-- c -->'])
    expect(textsOf(tokens, 'constant')).toEqual(['&nbsp;'])
  })

  it('script 内容换成 JS 的高亮', () => {
    const tokens = tokenizeOf('<script>const a = 1</script>', 'html')
    expect(textsOf(tokens, 'keyword')).toContain('const')
  })

  it('style 内容换成 CSS 的高亮', () => {
    const tokens = tokenizeOf('<style>a { color: red }</style>', 'html')
    expect(textsOf(tokens, 'property')).toContain('color')
  })

  it('光杆小于号当普通文字', () => {
    expect(() => tokenizeOf('a < b', 'html')).not.toThrow()
  })
})

describe('配置语言', () => {
  it('YAML 的 key 是 property、值是 string', () => {
    const tokens = tokenizeOf('name: "值"\nnum: 3', 'yaml')
    expect(textsOf(tokens, 'property')).toEqual(['name', 'num'])
    expect(textsOf(tokens, 'string')).toEqual(['"值"'])
    expect(textsOf(tokens, 'number')).toEqual(['3'])
  })

  it('YAML 里的 true/false 算常量', () => {
    expect(textsOf(tokenizeOf('debug: true', 'yaml'), 'constant')).toEqual(['true'])
  })

  it('TOML 的 [section]', () => {
    expect(textsOf(tokenizeOf('[server]\nport = 80', 'toml'), 'meta')).toEqual(['[server]'])
  })

  it('INI 的分号注释', () => {
    expect(textsOf(tokenizeOf('; 注释\nkey=1', 'ini'), 'comment')).toEqual(['; 注释'])
  })
})

describe('CSS', () => {
  it('选择器 / 属性 / 颜色 / 单位', () => {
    const tokens = tokenizeOf('.btn { color: #ff0000; margin: 8px }', 'css')
    expect(textsOf(tokens, 'tag')).toContain('.btn')
    expect(textsOf(tokens, 'property')).toEqual(['color', 'margin'])
    expect(textsOf(tokens, 'number')).toContain('#ff0000')
    expect(textsOf(tokens, 'number')).toContain('8px')
  })

  it('@media 与 !important', () => {
    const tokens = tokenizeOf('@media print { a { color: red !important } }', 'css')
    expect(textsOf(tokens, 'meta')).toContain('@media')
    expect(textsOf(tokens, 'keyword')).toContain('!important')
  })

  it('SCSS 的双斜杠注释', () => {
    expect(textsOf(tokenizeOf('a { // 说明\n}', 'scss'), 'comment')).toEqual(['// 说明'])
  })
})

describe('diff', () => {
  it('增行 / 删行 / 元信息', () => {
    const code = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-旧\n+新\n 上下文'
    const tokens = tokenizeOf(code, 'diff')
    expect(textsOf(tokens, 'meta')).toHaveLength(4)
    expect(textsOf(tokens, 'deletion')).toEqual(['-旧'])
    expect(textsOf(tokens, 'addition')).toEqual(['+新'])
  })
})

describe('Markdown 着色', () => {
  it('标题 / 代码块 / 引用', () => {
    const tokens = tokenizeOf('# 标题\n\n```js\nconst a = 1\n```\n\n> 引用', 'md')
    expect(textsOf(tokens, 'keyword')).toContain('# 标题')
    expect(textsOf(tokens, 'meta')).toContain('```js')
    expect(textsOf(tokens, 'comment')).toContain('> ')
  })
})

describe('兜底', () => {
  it('空代码返回空数组', () => {
    expect(tokenize('', 'ts')).toEqual([])
  })

  it('纯文本只有 plain', () => {
    expect(kinds('随便一段话', 'text')).toEqual(['plain'])
  })

  it('认不出的语言当纯文本', () => {
    expect(kinds('const a = 1', 'brainfuck')).toEqual(['plain'])
  })

  it('拼回原文不丢字符', () => {
    const samples: Array<[string, string]> = [
      ['const a = foo("x", 1) // c\n', 'ts'],
      ['def f(x):\n    return x * 2\n', 'py'],
      ['<a href="x">y</a>', 'html'],
      ['name: "v"\n', 'yaml'],
      ['a { color: red }', 'css'],
      ['# 标题\ntext', 'md'],
      ['+加\n-减', 'diff'],
      ['fn main() { println!("hi"); }', 'rs'],
    ]
    for (const [code, language] of samples) {
      expect(
        tokenize(code, language)
          .map((t) => t.text)
          .join(''),
      ).toBe(code)
    }
  })
})
