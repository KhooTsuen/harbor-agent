import { useEffect, type RefObject } from 'react'

/* ══════════════════════════════════════════════════════════════
   弹窗的键盘与焦点（P2 #19）

   从 `Modal.tsx` 抽出来的 —— 那边加上 Tab 循环就过了 300 行红线，
   而这三件事本就是**一组**（Esc / Tab / 焦点还回去），拆开看反而更乱。

   ── 四条规矩（每条都有测试钉着，见 `__tests__/modalFocus.test.tsx`）──
     ① 打开时焦点进弹窗：优先 `[data-initial-focus]`，否则第一个可交互项
     ② Tab / Shift+Tab 在弹窗内循环 —— 绝不落到背景界面
     ③ Escape 只让**最上面那层**响应（嵌套时不该一次关两层）
     ④ 关闭时焦点还给发起元素；入口已不在则落回文档根

   ── 为什么用栈而不是「每个弹窗自己判 z-index」──────────────────
   「恢复默认设置」是设置弹窗里再弹一个确认框。两个 Modal 都在 document
   上监听 keydown —— 不加栈的话一次 Esc 会同时关掉两层，而用户以为自己
   只取消了确认框。

   ★ 只收 `modal` 形态：anchored（贴输入区的确认条）不抢焦点、也不吃 Esc，
     它由自己的按钮答复主进程 —— 那两条路本来就不该抢键盘。
   ══════════════════════════════════════════════════════════════ */

/** 弹窗里能接焦点的东西（Tab 循环按这个清单走） */
export const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 打开着的弹窗（后进先出） */
const openStack: symbol[] = []

/** 只测试用：当前栈深（= 同时开着的模态层数） */
export function modalStackDepth(): number {
  return openStack.length
}

export function useModalFocus(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  restoreRef: RefObject<HTMLElement | null> & { current: HTMLElement | null },
  onClose: () => void,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!open || !enabled) return

    const token = Symbol('modal')
    openStack.push(token)

    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    /*
     * ★ 为什么不能只取第一个可交互元素：危险确认框的正文里可能有「查看 Diff」
     *   这类按钮，按 DOM 顺序它排在 footer 之前 —— 默认聚焦到它，用户敲 Enter
     *   就是「展开 Diff」，而不是他以为的「确认」。所以先认 `data-initial-focus`。
     */
    const focusFirst = (): void => {
      const panel = panelRef.current
      if (!panel) return
      const preferred = panel.querySelector<HTMLElement>('[data-initial-focus]')
      const first = panel.querySelector<HTMLElement>(FOCUSABLE)
      ;(preferred ?? first ?? panel).focus()
    }
    /* 挂载后一帧再聚焦：AnimatePresence 刚插进来时 panelRef 可能还是空的 */
    const raf = requestAnimationFrame(focusFirst)

    function onKeyDown(event: KeyboardEvent): void {
      /* 只让最上面那层响应 */
      if (openStack[openStack.length - 1] !== token) return

      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const panel = panelRef.current
      if (!panel) return
      /*
       * 可聚焦清单**不按 `offsetParent` 过滤**：本组件在 jsdom/happy-dom 里
       * 拿不到布局，那条判据会让清单恒为空、Tab 循环直接失效（测试逮到过）。
       * 只排除真正不可聚焦的：disabled、藏在 `hidden` 里的、标了 aria-hidden 的。
       */
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) =>
          !el.hasAttribute('disabled') &&
          el.getAttribute('aria-hidden') !== 'true' &&
          el.closest('[hidden]') === null,
      )
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      const inside = active instanceof HTMLElement && panel.contains(active)
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKeyDown)
      const at = openStack.lastIndexOf(token)
      if (at >= 0) openStack.splice(at, 1)
      /* 焦点还回去；入口已不在（比如右键菜单进来的，菜单早关了）就落回文档根 */
      const back = restoreRef.current
      if (back && document.contains(back) && !back.hasAttribute('disabled')) back.focus()
      else (document.body as HTMLElement).focus?.()
    }
  }, [open, panelRef, restoreRef, onClose, enabled])
}
