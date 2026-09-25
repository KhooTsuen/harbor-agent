import { useCallback, useEffect, useRef, useState } from 'react'

const EXIT_FADE_MS = 180

type ExitMode = 'none' | 'natural' | 'skip'

export function useBootGate(ready = true, enabled = true) {
  const [mainMounted, setMainMounted] = useState(!enabled)
  const [booting, setBooting] = useState(enabled)
  const [skipping, setSkipping] = useState(false)
  const [exitMode, setExitMode] = useState<ExitMode>('none')
  const exitRequestedRef = useRef(false)

  /*
   * 关掉启动动画（外观页的开关）：不等就绪、启动层一帧都不渲染 ——
   * 主界面直接上。首帧由 useState 的初始值兑住，这里管的是中途改开关。
   */
  useEffect(() => {
    if (enabled) return
    setMainMounted(true)
    setBooting(false)
  }, [enabled])

  const prepareMain = useCallback(() => {
    if (ready) setMainMounted(true)
  }, [ready])

  const finishBoot = useCallback(() => {
    if (exitRequestedRef.current) return
    exitRequestedRef.current = true
    setExitMode('natural')
  }, [])

  const skipBoot = useCallback(() => {
    if (exitRequestedRef.current) return
    exitRequestedRef.current = true
    setExitMode('skip')
  }, [])

  useEffect(() => {
    if (!enabled || !ready || exitMode === 'none') return
    setMainMounted(true)

    if (exitMode === 'natural') {
      setBooting(false)
      return
    }

    setSkipping(true)
    const timer = window.setTimeout(() => setBooting(false), EXIT_FADE_MS)
    return () => window.clearTimeout(timer)
  }, [exitMode, ready])

  return { mainMounted, booting, skipping, prepareMain, finishBoot, skipBoot }
}
