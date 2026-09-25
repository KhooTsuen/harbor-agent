import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* ══════════════════════════════════════════════════════════════
   侧栏行：悬停不许改变行高（2026-09-26）

   行里「悬停才现身的操作槽」装的是 28px 的 IconButton，而行内文字行高只有
   约 20px（text-dense 14px × 1.43）—— 槽照常参与布局时，鼠标扫过列表
   行高会 32px → 40px 一跳一跳（真机量过：212×32 → 212×40）。

   办法：槽钉成 1rem（h-4）+ items-center —— 28px 按钮多出来的高度上下对称
   溢出（行有 6px 内边距兜着），行高仍由文字决定。这条测试盯住那两个类。

   注：`ProjectGroup.tsx` 里也有同款写法，但那个组件已经没人用了（侧栏两栏
   结构现由 SidebarPanes 的 FolderSection 渲染，那里的「+」是常驻按钮）——
   别照它抄，也别把它的存在当成「还有一处要修」。
   ══════════════════════════════════════════════════════════════ */

const hoverSlotLines = (file: string): string[] =>
  readFileSync(join(__dirname, '..', file), 'utf8')
    .split('\n')
    .filter((line) => line.includes('group-hover:flex'))

describe('侧栏行 / 悬停不改变行高', () => {
  it('线程行的悬停操作槽钉了高度（h-4 + items-center）', () => {
    const slots = hoverSlotLines('ThreadRow.tsx')
    expect(slots.length).toBeGreaterThan(0)
    for (const line of slots) {
      expect(line).toContain('h-4')
      expect(line).toContain('items-center')
    }
  })
})
