import { useCallback, useEffect, useRef } from 'react'
import { matchCombo } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   useKeyboardShortcuts —— 全局快捷键

   一个 map：combo → handler。combo 形如 "mod+k" / "mod+shift+g"。
   在输入框里时默认**不**拦截（打字不能被快捷键打断），
   除非对应 handler 显式声明 allowInInput。
   ══════════════════════════════════════════════════════════════ */

export interface ShortcutBinding {
  combo: string
  handler: (event: KeyboardEvent) => void
  /** 输入框里也生效（比如 mod+enter 发送） */
  allowInInput?: boolean
}

export function useKeyboardShortcuts(bindings: readonly ShortcutBinding[]): void {
  const ref = useRef(bindings)
  ref.current = bindings

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    const inInput =
      event.target instanceof HTMLElement &&
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)

    for (const binding of ref.current) {
      if (inInput && !binding.allowInInput) continue
      if (matchCombo(event, binding.combo)) {
        event.preventDefault()
        binding.handler(event)
        break
      }
    }
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])
}
