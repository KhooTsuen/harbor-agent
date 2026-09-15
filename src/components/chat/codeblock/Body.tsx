import type { TokenKind } from '@/lib/highlight'
import { ITALIC_TOKENS, TOKEN_COLOR, TOKEN_LINE_BG } from '@/lib/highlight'
import { cn } from '@/lib/utils'
import type { Piece } from './lines'

/* ══════════════════════════════════════════════════════════════
   代码行渲染

   行号用 sticky 固定在左边 —— 横向滚动看长行时行号不会跟着跑掉。
   （代价是行号栏必须有实底，否则代码会从下面透出来。）

   diff 的整行底色由行首 token 决定，所以 `+` / `-` 一眼能扫出来。
   ══════════════════════════════════════════════════════════════ */

export interface CodeBodyProps {
  lines: Piece[][]
  numbers: boolean
  wrap: boolean
  highlightLines?: number[]
  /** 行号栏宽度，由总行数算出来，避免滚动时宽度跳变 */
  gutter: string
  /** 字体大小类，文件预览会比对话里更小一档 */
  dense?: boolean
}

export function CodeBody({ lines, numbers, wrap, highlightLines, gutter, dense }: CodeBodyProps) {
  const marked = new Set(highlightLines ?? [])

  return (
    <div className="overflow-x-auto">
      <pre
        className={cn(
          'py-2 font-mono leading-[1.6]',
          dense ? 'text-2xs' : 'text-xs',
          wrap && 'whitespace-pre-wrap',
        )}
      >
        <code>
          {lines.map((line, index) => {
            const number = index + 1
            const head = line[0]?.kind as TokenKind | undefined
            const tint = head ? TOKEN_LINE_BG[head] : undefined
            const isMarked = marked.has(number)

            return (
              <div
                key={number}
                className="flex min-h-[1.6em]"
                style={tint ? { background: tint } : undefined}
              >
                {numbers ? (
                  <span
                    className="sticky left-0 shrink-0 select-none bg-bg-surface pr-3 text-right text-fg-tertiary"
                    style={{ width: gutter }}
                  >
                    {number}
                  </span>
                ) : null}

                {/* 强调行：左边一道竖线，比整行铺底色安静 */}
                {isMarked ? (
                  <span
                    className="w-0.5 shrink-0"
                    style={{ background: 'var(--accent-blue)' }}
                    aria-hidden
                  />
                ) : null}

                <span className="min-w-0 flex-1 pl-3 pr-4">
                  {line.length === 0 ? (
                    <span> </span>
                  ) : (
                    line.map((piece, pieceIndex) => (
                      <span
                        key={pieceIndex}
                        style={{
                          color: TOKEN_COLOR[piece.kind],
                          fontStyle: ITALIC_TOKENS.has(piece.kind) ? 'italic' : undefined,
                        }}
                      >
                        {piece.text}
                      </span>
                    ))
                  )}
                </span>
              </div>
            )
          })}
        </code>
      </pre>
    </div>
  )
}
