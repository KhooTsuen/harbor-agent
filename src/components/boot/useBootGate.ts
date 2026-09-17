import { useCallback, useEffect, useRef, useState } from 'react'

const EXIT_FADE_MS = 180

type ExitMode = 'none' | 'natural' | 'skip'

export function useBootGate(ready = true) {
  const [mainMounted, setMainMounted] = useState(false)
  const [booting, setBooting] = useState(true)
  const [skipping, setSkipping] = useState(false)
  const [exitMode, setExitMode] = useState<ExitMode>('none')
  const exitRequestedRef = useRef(false)

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
    if (!ready || exitMode === 'none') return
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
