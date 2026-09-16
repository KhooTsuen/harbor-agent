import { useEffect, useState } from 'react'
import frames from '@/assets/banner/aperture-frames.json'
// Precomposed ASCII frames: solid ring behind the fixed original lettering.
export const BANNER_FRAMES = frames

export function useBannerAnimation() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
    let timer: ReturnType<typeof setInterval> | undefined
    const sync = () => {
      clearInterval(timer)
      if (!document.hidden && !reducedMotion.matches) {
        timer = setInterval(() => setFrame((current) => (current + 1) % BANNER_FRAMES.length), 125)
      }
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    reducedMotion.addEventListener('change', sync)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', sync)
      reducedMotion.removeEventListener('change', sync)
    }
  }, [])
  return BANNER_FRAMES[frame]
}
