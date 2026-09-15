import type { Align, InlineNode } from '@/lib/markdown'
import { Inline } from './Inline'

/* ══════════════════════════════════════════════════════════════
   GFM 表格

   对齐用 colgroup 之外最简单的方式：每格 text-align。
   表格宽度给 `w-full` + 单元格 `break-words` ——
   模型很喜欢造超宽表格，不给换行的话整条消息会被撑出横向滚动条。
   ══════════════════════════════════════════════════════════════ */

export interface TableProps {
  align: Align[]
  header: InlineNode[][]
  rows: InlineNode[][][]
}

function alignStyle(index: number, align: Align[]): { textAlign: 'left' | 'center' | 'right' } {
  return { textAlign: align[index] ?? 'left' }
}

export function Table({ align, header, rows }: TableProps) {
  return (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-base">
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th
                key={index}
                style={alignStyle(index, align)}
                className="border-b border-line-strong px-2.5 py-1.5 font-semibold text-fg-primary"
              >
                <Inline nodes={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-line-hairline last:border-b-0">
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  style={alignStyle(cellIndex, align)}
                  className="break-words px-2.5 py-1.5 align-top text-fg-secondary"
                >
                  <Inline nodes={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
