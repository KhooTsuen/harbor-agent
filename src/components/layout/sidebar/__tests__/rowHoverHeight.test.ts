import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* ══════════════════════════════════════════════════════════════
   侧栏行：悬停不许改变布局、按钮必须常显（2026-09-26，三轮）

   第一轮：悬停时长高（32 → 40px）—— 悬停槽里的 28px IconButton 比文字行高
   高，参与布局就把行顶起来。第二轮：悬停还会**换内容** —— 时间藏起来、按钮
   顶出来，整行右半边跳。第三轮（最终形态）：按钮**常显** —— 不是「悬停才渐显」
   （用户 2026-09-26 明确要求）。

   现在的约定（这条测试盯住）：
   · 行内没有 group-hover:hidden —— 悬停不藏任何信息
   · 操作槽占地恒定（h-4 w-7，不带 hidden / 悬停才 flex）—— 不位移
   · 整份源文件没有任何悬停门（group-hover / opacity-0 / group-focus-within）
     —— 按钮常显（扫描前先剥块注释：注释里会写这些类名，不剥会误报）

   注：`ProjectGroup.tsx` 里也有同款写法，但那个组件已经没人用了（侧栏两栏
   结构现由 SidebarPanes 的 FolderSection 渲染，那里的「+」是常驻按钮）——
   别照它抄，也别把它的存在当成「还有一处要修」。
   ══════════════════════════════════════════════════════════════ */

/* 先把块注释剥掉再扫 —— 注释里会写这些类名，不剥会误报（且别在注释里写反斜杠星号斜杠） */
const codeLines = (file: string): string[] =>
  readFileSync(join(__dirname, '..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')

describe('侧栏行 / 悬停不改变布局、按钮常显', () => {
  it('悬停不藏信息：没有 group-hover:hidden', () => {
    const hides = codeLines('ThreadRow.tsx').filter((line) => line.includes('group-hover:hidden'))
    expect(hides).toEqual([])
  })

  it('操作槽占地恒定（h-4 w-7 + items-center，不带 hidden / group-hover:flex）', () => {
    const slots = codeLines('ThreadRow.tsx').filter((line) => line.includes('h-4 w-7'))
    expect(slots.length).toBe(1)
    expect(slots[0]).toContain('items-center')
    expect(slots[0]).not.toContain('hidden')
    expect(slots[0]).not.toContain('group-hover:flex')
  })

  it('按钮常显：没有任何悬停门（group-hover / opacity-0 / group-focus-within）', () => {
    const gates = codeLines('ThreadRow.tsx').filter((line) =>
      /group-hover:|opacity-0|group-focus-within:/.test(line),
    )
    expect(gates).toEqual([])
  })
})
