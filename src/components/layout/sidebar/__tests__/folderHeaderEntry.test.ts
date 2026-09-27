import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* ══════════════════════════════════════════════════════════════
   「对话文件夹」那一栏的入口（2026-09-28）

   用户报的：里面那个「新建对话（放进第一个文件夹）」是**多余的** ——
   它是「单独对话还是主路」那会儿的遗留，点下去塞进 `folderList[0]`（随手挑的
   第一个文件夹），语义模糊，而且和下半栏「新建单独对话」职责重叠。

   现在的约定（这条测试盯住）：
     · 表头**只留一个**入口：「新建对话并指定目录」
     · 不再有指向 folderList[0] 的「新建对话」按钮
     · 文件夹行上「在这个文件夹里新建对话」照旧（那是明确的归属操作，不是遗留）

   扫描前先剥块注释 —— 注释里会提到被删掉的那个按钮（不剥会误报）。
   ══════════════════════════════════════════════════════════════ */

const codeLines = (file: string): string[] =>
  readFileSync(join(__dirname, '..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')

describe('对话文件夹 / 表头入口', () => {
  it('★ 没有「新建对话（放进第一个文件夹）」了', () => {
    const lines = codeLines('SidebarPanes.tsx')
    expect(lines.filter((line) => line.includes('放进第一个文件夹'))).toEqual([])
    /* 那个按钮的 label 就是「新建对话」—— 指向 folderList[0]，已删 */
    expect(lines.filter((line) => /label="新建对话"/.test(line))).toEqual([])
    /* 也不许再有人拿 folderList[0] 当新对话的归属 */
    expect(lines.filter((line) => line.includes('folderList[0]'))).toEqual([])
  })

  it('指定目录那个入口必须还在（这是文件夹那一栏唯一的建对话入口）', () => {
    const lines = codeLines('SidebarPanes.tsx')
    expect(lines.filter((line) => line.includes('新建对话并指定目录')).length).toBeGreaterThan(0)
    expect(lines.filter((line) => line.includes('newThreadInFolder')).length).toBeGreaterThan(0)
  })

  it('下半栏「新建单独对话」照旧', () => {
    const lines = codeLines('SidebarPanes.tsx')
    expect(lines.filter((line) => line.includes('新建单独对话')).length).toBeGreaterThan(0)
  })

  it('文件夹行上的「在这个文件夹里新建对话」照旧', () => {
    const lines = codeLines('SidebarPanes.tsx')
    expect(lines.filter((line) => line.includes('在这个文件夹里新建对话')).length).toBeGreaterThan(
      0,
    )
  })
})
