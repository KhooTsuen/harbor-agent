import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   JSX 字符串属性里不许出现 `\n`

   这一条是**真机截图里发现之后补的**：

     placeholder="# 项目规则\n\n测试命令、目录约定……"

   JSX 的属性值和 HTML 一样，**不做转义** —— `\n` 就是两个字符
   「反斜杠 + n」，于是界面上直接显示成 `\n`。而在**表达式**里
   （`placeholder={'...\n...'}`）才是 JS 字符串，`\n` 才是换行。

   同一类坑今天已经踩过两次了（`session-read.cjs` 的工具重放、
   这里的 placeholder），共同点是**类型检查全绿、只有肉眼能发现**。
   所以写成测试：扫源码，见到就红。

   豁免：正则字面量（`/\\\n/`）、模板字符串里故意展示的示例代码。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(process.cwd(), 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(full) && !full.includes('__tests__')) out.push(full)
  }
  return out
}

/** 在一行里找形如 属性="...\n..." 的写法（双引号字符串属性） */
function literalEscapeInAttribute(line: string): boolean {
  /* 只看双引号属性，且排除正则字面量 */
  const match = /="[^"]*\\n[^"]*"/.exec(line)
  if (!match) return false
  if (line.includes('RegExp') || line.includes('/^')) return false
  return true
}

describe('JSX 属性里的转义', () => {
  it('字符串属性里没有写错的 \\n', () => {
    const offenders: string[] = []

    for (const file of walk(ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (literalEscapeInAttribute(line)) {
          offenders.push(
            `${file.replace(process.cwd(), '')}:${index + 1}  ${line.trim().slice(0, 90)}`,
          )
        }
      })
    }

    expect(offenders, `这些地方会把 \\n 原样显示给用户：\n${offenders.join('\n')}`).toEqual([])
  })
})
