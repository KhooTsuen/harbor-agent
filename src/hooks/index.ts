import { useCallback, useEffect, useRef, useState } from 'react'

/* ══════════════════════════════════════════════════════════════
   Hooks 集合

   每个都是独立、可测的纯 React hook，不依赖 store。
   ══════════════════════════════════════════════════════════════ */

/** 防抖：只在停手 delay 毫秒后才更新 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])

  return debounced
}

/** 节流：固定频率最多触发一次 */
export function useThrottle<T>(value: T, interval = 200): T {
  const [throttled, setThrottled] = useState(value)
  const last = useRef(0)

  useEffect(() => {
    const now = Date.now()
    if (now - last.current >= interval) {
      last.current = now
      setThrottled(value)
      return
    }
    const timer = window.setTimeout(
      () => {
        last.current = Date.now()
        setThrottled(value)
      },
      interval - (now - last.current),
    )
    return () => window.clearTimeout(timer)
  }, [value, interval])

  return throttled
}

/** 读媒体查询（含 prefers-* 那几个） */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  )

  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = (): void => setMatches(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** 类型安全的 localStorage 封装（含 SSR 保护） */
export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial
    try {
      const raw = window.localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        try {
          window.localStorage.setItem(key, JSON.stringify(resolved))
        } catch {
          /* 存不进去（隐私模式）不打断使用 */
        }
        return resolved
      })
    },
    [key],
  )

  return [value, set] as const
}

/** 点击组件外部时触发 */
export function useClickOutside<T extends HTMLElement>(
  onOutside: () => void,
): React.RefObject<T | null> {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutside()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [onOutside])

  return ref
}

/** 焦点锁定在容器内（弹窗用） */
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    if (!active || !ref.current) return
    const node = ref.current
    const focusables = (): HTMLElement[] =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )

    const first = focusables()[0]
    first?.focus()

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      if (!firstItem || !lastItem) return
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault()
        firstItem.focus()
      }
    }
    node.addEventListener('keydown', onKeyDown)
    return () => node.removeEventListener('keydown', onKeyDown)
  }, [active])

  return ref
}
