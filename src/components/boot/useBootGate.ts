import { useCallback, useEffect, useRef, useState } from 'react'

const SKIP_FADE_MS = 180

export function useBootGate() {
  const [mainMounted, setMainMounted] = useState(false)
  const [booting, setBooting] = useState(true)
  const [skipping, setSkipping] = useState(false)
  const skipTimerRef = useRef<number | null>(null)

  const prepareMain = useCallback(() => setMainMounted(true), [])
  const finishBoot = useCallback(() => {
    setMainMounted(true)
    setBooting(false)
  }, [])

  const skipBoot = useCallback(() => {
    if (skipTimerRef.current !== null) return
    setMainMounted(true)
    setSkipping(true)
    skipTimerRef.current = window.setTimeout(finishBoot, SKIP_FADE_MS)
  }, [finishBoot])

  /* 卸载时把没跑完的淡出定时器收掉 —— 现在 App 是根组件不会卸载，但规矩要有 */
  useEffect(() => {
    return () => {
      if (skipTimerRef.current !== null) window.clearTimeout(skipTimerRef.current)
    }
  }, [])

  return { mainMounted, booting, skipping, prepareMain, finishBoot, skipBoot }
}
