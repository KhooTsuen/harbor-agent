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
    /*
     * Phase 7 一期：圆角 + 外框加在**已有的**这层 `overflow-x-auto` div 上 ——
     * ★ 绝不新增包裹节点（那属 DOM 结构变更，会打破流式/整篇的 DOM 对等）。
     * `overflow-x-auto` 会让圆角真的裁到内容（另一轴 visible 会退化成 auto）。
     */
    <div className="my-3 overflow-x-auto rounded border border-line-subtle">
      <table className="w-full border-collapse text-base">
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th
                key={index}
                style={alignStyle(index, align)}
                className="border-b border-line-strong bg-bg-raised px-3 py-2 font-semibold text-fg-primary"
              >
                <Inline nodes={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr
              key={rowIndex}
              className="border-b border-line-hairline last:border-b-0 hover:bg-bg-hover/50"
            >
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  style={alignStyle(cellIndex, align)}
                  className="break-words px-3 py-2 align-top text-fg-secondary"
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
