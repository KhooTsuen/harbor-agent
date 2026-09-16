import { describe, expect, it } from 'vitest'
import art from '@/assets/aperture.txt?raw'

/* ══════════════════════════════════════════════════════════════
   空状态横幅那张 ASCII 图

   它是个**数据文件**，不是代码 —— 但改坏一点（多一个换行、
   编辑器自动 trim、把行尾空格删过头）在界面上就是「图歪了」，
   编译器一声不吭。所以在这里钉死它的形状。

   渲染侧靠的是「按容器宽度反推字号、绝不换行」，
   所以宽高这两件事必须稳定。
   ══════════════════════════════════════════════════════════════ */

const LINES = art.replace(/\s+$/, '').split('\n')

describe('Aperture ASCII 横幅', () => {
  it('行数固定（换行会让图散架）', () => {
    expect(LINES).toHaveLength(62)
  })

  it('宽度在预期范围（宽度变了字号会跟着变，图会缩水）', () => {
    const widest = Math.max(...LINES.map((l) => l.length))
    expect(widest).toBeGreaterThan(480)
    expect(widest).toBeLessThan(520)
  })

  it('只用 @ . 和空格（混进别的字符就是文件被改坏了）', () => {
    const used = [...new Set(art.replace(/\n/g, ''))].sort().join('')
    expect(used).toBe(' .@')
  })

  it('不是空的、也不是只有空格', () => {
    expect(art).toContain('@')
    expect(art.replace(/[\s.@]/g, '')).toBe('')
  })
})
