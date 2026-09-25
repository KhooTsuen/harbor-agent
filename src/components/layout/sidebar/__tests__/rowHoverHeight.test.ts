import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* ══════════════════════════════════════════════════════════════
   侧栏行：悬停不许改变布局（2026-09-26，两轮）

   第一轮：悬停时长高（32 → 40px）—— 悬停槽里的 28px IconButton 比文字行高
   高，参与布局就把行顶起来。第二轮（用户：「不要乱动」+「也要显示图1 的信息」）：
   悬停还会**换内容** —— 时间与模式首字藏起来、按钮顶出来，鼠标扫过列表时
   整行右半边跳来跳去。

   现在的约定（这条测试盯住）：
   · 行内**没有** group-hover:hidden —— 悬停不藏任何信息
   · 操作槽占地恒定（h-4 w-7，不带 hidden / group-hover:flex）—— 不位移
   · 按钮只做透明度渐显（opacity-0 → group-hover:opacity-100）

   注：`ProjectGroup.tsx` 里也有同款写法，但那个组件已经没人用了（侧栏两栏
   结构现由 SidebarPanes 的 FolderSection 渲染，那里的「+」是常驻按钮）——
   别照它抄，也别把它的存在当成「还有一处要修」。
   ══════════════════════════════════════════════════════════════ */

const sourceLines = (file: string): string[] =>
  readFileSync(join(__dirname, '..', file), 'utf8').split('\n')

describe('侧栏行 / 悬停不改变布局', () => {
  it('悬停不藏信息：没有 group-hover:hidden', () => {
    const hides = sourceLines('ThreadRow.tsx').filter((line) => line.includes('group-hover:hidden'))
    expect(hides).toEqual([])
  })

  it('操作槽占地恒定（h-4 w-7 + items-center，不带 hidden / group-hover:flex）', () => {
    const slots = sourceLines('ThreadRow.tsx').filter((line) => line.includes('h-4 w-7'))
    expect(slots.length).toBe(1)
    expect(slots[0]).toContain('items-center')
    expect(slots[0]).not.toContain('hidden')
    expect(slots[0]).not.toContain('group-hover:flex')
  })

  it('按钮只做透明度渐显（opacity-0 → group-hover:opacity-100）', () => {
    const reveals = sourceLines('ThreadRow.tsx').filter((line) => line.includes('opacity-0'))
    expect(reveals.length).toBe(1)
    expect(reveals[0]).toContain('group-hover:opacity-100')
  })
})
