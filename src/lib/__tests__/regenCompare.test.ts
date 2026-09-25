import { describe, expect, it } from 'vitest'
import { alignToolSequences, diffLines, fileTouchesOf, toolSequenceOf } from '../regenCompare'
import type { StoredMessage } from '@/types/models-extra'

/* ══════════════════════════════════════════════════════════════
   「对比两次生成」的纯函数（界面在 components/chat/message/RegenCompare.tsx）
   ══════════════════════════════════════════════════════════════ */

describe('diffLines（输出差异）', () => {
  it('完全相同的文本：没有加行 / 删行', () => {
    const d = diffLines('a\nb\nc', 'a\nb\nc')
    expect(d.added).toBe(0)
    expect(d.removed).toBe(0)
    expect(d.rows.every((r) => r.kind === 'same')).toBe(true)
  })

  it('★ 中间改动：逐行列出来（加行 / 删行）', () => {
    const d = diffLines('a\nb\nc\nd', 'a\nB\nc\nd')
    expect(d.added).toBe(1)
    expect(d.removed).toBe(1)
    expect(d.rows.filter((r) => r.kind === 'add').map((r) => r.text)).toEqual(['B'])
    expect(d.rows.filter((r) => r.kind === 'del').map((r) => r.text)).toEqual(['b'])
  })

  it('长段相同内容折叠成一行（差异才看得见）', () => {
    const same = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')
    const d = diffLines(`${same}\nold`, `${same}\nnew`)
    expect(d.rows.some((r) => r.text.includes('省略'))).toBe(true)
  })

  it('超大文本退回逐行比（不卡界面，差异仍给出）', () => {
    const a = Array.from({ length: 600 }, (_, i) => `x${i}`).join('\n')
    const b = Array.from({ length: 600 }, (_, i) => `y${i}`).join('\n')
    const d = diffLines(a, b)
    expect(d.added).toBe(600)
    expect(d.removed).toBe(600)
    expect(d.truncated).toBe(true)
  })
})

describe('工具序列 / 文件改动', () => {
  const rec = (runs: Array<{ name: string; ok: boolean; output: string }>): StoredMessage => ({
    role: 'assistant',
    content: 'x',
    toolRuns: runs.map((r, i) => ({ id: `r${i}`, ...r })),
  })

  it('序列原样取出（名字 / 成败 / 首行）', () => {
    const steps = toolSequenceOf(
      rec([{ name: 'read_file', ok: true, output: 'E:\\a.md（共 3 行）\n尾' }]),
    )
    expect(steps[0]).toEqual({ name: 'read_file', ok: true, detail: 'E:\\a.md（共 3 行）' })
  })

  it('对齐两个序列：一样 / 换了 / 只在某一边', () => {
    const a = toolSequenceOf(
      rec([
        { name: 'read_file', ok: true, output: '' },
        { name: 'edit_file', ok: true, output: '' },
      ]),
    )
    const b = toolSequenceOf(
      rec([
        { name: 'read_file', ok: true, output: '' },
        { name: 'write_file', ok: true, output: '' },
        { name: 'run_shell', ok: false, output: '' },
      ]),
    )
    const rows = alignToolSequences(a, b)
    expect(rows[0]?.kind).toBe('same')
    expect(rows[1]?.kind).toBe('diff')
    expect(rows[2]?.kind).toBe('onlyB')
  })

  it('文件改动只认写类工具（write_file / edit_file），路径从输出抠出、同名合并', () => {
    const files = fileTouchesOf(
      rec([
        { name: 'read_file', ok: true, output: 'E:\\proj\\readme.md 读完了' },
        { name: 'write_file', ok: true, output: '已写入 E:\\proj\\readme.md（12 行）' },
        { name: 'edit_file', ok: true, output: '已修改 E:\\proj\\readme.md' },
        { name: 'run_shell', ok: true, output: 'echo hi' },
      ]),
    )
    expect(files).toEqual([{ file: 'E:\\proj\\readme.md', count: 2 }])
  })

  it('写类工具也没跑过 → 空列表（界面说「没有记录到文件改动」）', () => {
    expect(fileTouchesOf(rec([{ name: 'list_dir', ok: true, output: '.' }]))).toEqual([])
  })
})
