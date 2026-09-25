import { useCallback, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { clamp } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   ResizeHandle —— 拖拽调整尺寸

   两种方向：
     horizontal  左右拖，调**宽度**（左/右栏用）
     vertical    上下拖，调**高度**（侧栏里「文件夹 / 单独对话」的分隔线用）

   用 pointerdown + pointermove，比 mousedown/mousemove 更省事
   （自动处理指针离开窗口的情况，靠 setPointerCapture）。
   拖拽期间给 body 加 cursor，避免划过 iframe/文本时鼠标变形。

   **min/max 必须传对**：上下分栏那条线特别容易把某一栏挤成 0 高度，
   挤没之后用户就再也抓不到它了（没有手柄可点，等于这个面板永远消失）。
   所以调用方要给够下限，这里也会 clamp。
   ══════════════════════════════════════════════════════════════ */

export interface ResizeHandleProps {
  /** 当前值（宽度或高度，px） */
  value: number
  min: number
  max: number
  onChange: (next: number) => void
  /** 拖拽结束才回调（用于写进持久化） */
  onCommit?: (next: number) => void
  /**
   * 手柄在容器的哪一侧。
   * horizontal：'left'（右栏）/ 'right'（左栏）
   * vertical：  'top'（下手柄，往上拖变高）/ 'bottom'（上手柄，往下拖变高）
   */
  side: 'left' | 'right' | 'top' | 'bottom'
  label: string
  orientation?: 'horizontal' | 'vertical'
}

export function ResizeHandle({
  value,
  min,
  max,
  onChange,
  onCommit,
  side,
  label,
  orientation = 'horizontal',
}: ResizeHandleProps) {
  const vertical = orientation === 'vertical'
  const startRef = useRef({ pos: 0, value: 0, dragging: false })

  /*
   * 最新值。键盘连续点按必须靠它累加 ——
   * React 的 state 在同一帧里不会更新，所以直接读 `value` prop 的话，
   * 连按 30 次只会挪一步（全都在拿同一个旧值算）。这个坑实测踩到过。
   */
  const latest = useRef(value)
  useEffect(() => {
    latest.current = value
  }, [value])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      startRef.current = {
        pos: vertical ? event.clientY : event.clientX,
        value,
        dragging: true,
      }
      document.body.style.cursor = vertical ? 'row-resize' : 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [value, vertical],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!startRef.current.dragging) return
      const delta = (vertical ? event.clientY : event.clientX) - startRef.current.pos

      /*
       * 手柄在「起始侧」时，往正方向拖是变小：
       *   左栏（right）往右拖 → 变窄
       *   分栏线（bottom）往下拖 → 上面那栏变高
       *   分栏线（top）往 上 拖 → 上面那栏变高，所以要取反
       */
      const grows =
        side === 'right' || side === 'bottom'
          ? startRef.current.value + delta
          : startRef.current.value - delta

      onChange(clamp(grows, min, max))
    },
    [max, min, onChange, side, vertical],
  )

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!startRef.current.dragging) return
      startRef.current.dragging = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      onCommit?.(value)
    },
    [onCommit, value],
  )

  /* 卸载时兜底清干净，避免异常退出后光标卡在 col-resize */
  useEffect(() => {
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  function nudge(step: number): void {
    const next = clamp(latest.current + step, min, max)
    latest.current = next
    onChange(next)
    onCommit?.(next)
  }

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(e) => {
        /* 键盘也能调，方向键按 8px 走、Shift 加速 */
        const step = e.shiftKey ? 24 : 8
        const [decrease, increase] = vertical
          ? ['ArrowUp', 'ArrowDown']
          : ['ArrowLeft', 'ArrowRight']
        if (e.key === decrease) {
          e.preventDefault()
          /* 上下方向里，手柄在上面时「上」是变大 */
          nudge(side === 'top' ? step : -step)
        }
        if (e.key === increase) {
          e.preventDefault()
          /* 左右方向里，手柄在右边时「右」是变大 */
          nudge(side === 'right' || side === 'bottom' ? step : -step)
        }
      }}
      className={cn(
        'group relative shrink-0 bg-transparent focus-visible:outline-none',
        vertical ? 'h-px w-full cursor-row-resize' : 'w-px cursor-col-resize',
      )}
    >
      {/*
        视觉上只有 1px，热区是**不对称**的：左侧 1px、右侧 12px（DEF-UI-04）。

        为什么不对称：本应用所有滚动条都长在容器的**右缘**——无论左栏还是右栏手柄，
        它的左边都紧贴着某个容器的右缘（聊天区 / 侧栏的滚动条都在那儿），
        右边则是容器的左缘（没有滚动条）。热区若向两侧各扩 12px，会把整条滚动条盖住：
        真机实测过——滚动条 10px 被 25px 热区全覆盖，光标变 col-resize，
        想拖滚动条结果拖的是面板宽度。

        为什么带 z-10：面板内容里有 relative 元素，默认会画在 z-auto 的定位元素之上 ——
        不加 z 的话右侧那 12px 热区被盖住、形同虚设（真机命中测试验证过），
        抓手就只剩线的左右 1px，太难点中。

        ⚠️ 别改回对称（-left-3 -right-3）—— 会重新盖住邻居的滚动条。
        垂直方向（上/下）的两侧邻居都没滚动条，维持 ±12px、不动 z。
      */}
      <span
        className={cn(
          'absolute',
          vertical ? 'inset-x-0 -top-3 -bottom-3' : 'inset-y-0 -left-px -right-3 z-10',
        )}
      />
      <span
        className={cn(
          'absolute bg-line-subtle transition-colors duration-fast',
          'group-hover:bg-line-strong group-focus-visible:bg-line-focus',
          vertical ? 'inset-x-0 top-0 h-px' : 'inset-y-0 left-0 w-px',
        )}
      />
    </div>
  )
}
