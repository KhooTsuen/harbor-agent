import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  BOOT_TIMING,
  EASTER_EGGS,
  glitchLine,
  progressBar,
  progressValue,
  reconstructLogo,
  telemetry,
  typeBootCopy,
} from './bootFrames'

interface BootSequenceProps {
  skipping: boolean
  onSkip: () => void
  onPrepare: () => void
  onDone: () => void
}

const FRAME_INTERVAL = 1000 / 20
const SKIP_FADE_MS = 180

export function BootSequence({ skipping, onSkip, onPrepare, onDone }: BootSequenceProps) {
  const [elapsed, setElapsed] = useState(0)
  const [easterEgg] = useState(() => EASTER_EGGS[Math.floor(Math.random() * EASTER_EGGS.length)])
  const preparedRef = useRef(false)
  const finishedRef = useRef(false)
  const logoVisible = elapsed >= BOOT_TIMING.logoStart
  const logoWrapRef = useRef<HTMLDivElement>(null)
  const logoRef = useRef<HTMLPreElement>(null)

  const prepareOnce = useCallback(() => {
    if (preparedRef.current) return
    preparedRef.current = true
    onPrepare()
  }, [onPrepare])

  const finishOnce = useCallback(() => {
    if (finishedRef.current) return
    finishedRef.current = true
    onDone()
  }, [onDone])

  useEffect(() => {
    const startedAt = performance.now()
    let animationFrame = 0
    let lastPaint = 0

    const tick = (now: number): void => {
      const nextElapsed = Math.min(now - startedAt, BOOT_TIMING.total)
      if (nextElapsed - lastPaint >= FRAME_INTERVAL || nextElapsed === BOOT_TIMING.total) {
        setElapsed(nextElapsed)
        lastPaint = nextElapsed
      }
      if (nextElapsed >= BOOT_TIMING.prepareMain) prepareOnce()
      if (nextElapsed >= BOOT_TIMING.total) {
        finishOnce()
        return
      }
      animationFrame = requestAnimationFrame(tick)
    }

    animationFrame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animationFrame)
  }, [finishOnce, prepareOnce])

  useLayoutEffect(() => {
    const wrap = logoWrapRef.current
    const pre = logoRef.current
    if (!wrap || !pre || !logoVisible) return

    const fit = (): void => {
      if (!wrap.clientWidth || !wrap.clientHeight) return
      pre.style.fontSize = '100px'
      if (!pre.scrollWidth || !pre.scrollHeight) return
      const scale = Math.min(
        wrap.clientWidth / pre.scrollWidth,
        wrap.clientHeight / pre.scrollHeight,
      )
      pre.style.fontSize = `${Math.min(8, 100 * scale)}px`
    }

    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [logoVisible])

  const progress = progressValue(elapsed)
  const streamFrame = Math.floor(elapsed / 110)
  const logoFrame = Math.floor(elapsed / 120)
  const logoElapsed = logoFrame * 120
  const logoProgress =
    (logoElapsed - BOOT_TIMING.logoStart) / (BOOT_TIMING.logoComplete - BOOT_TIMING.logoStart)
  const logo = useMemo(() => reconstructLogo(logoProgress, logoFrame), [logoFrame, logoProgress])
  const cursorVisible = Math.floor(elapsed / 260) % 2 === 0
  const fadeOpacity =
    elapsed >= BOOT_TIMING.fadeStart
      ? 1 - (elapsed - BOOT_TIMING.fadeStart) / (BOOT_TIMING.total - BOOT_TIMING.fadeStart)
      : 1
  const scanTop = ((elapsed / 1800) % 1) * 100

  return (
    <div
      className="fixed inset-0 z-[90] flex cursor-pointer select-none flex-col overflow-hidden bg-black font-mono text-[#E6E6E6]"
      style={{
        opacity: skipping ? 0 : Math.max(0, fadeOpacity),
        transition: skipping ? `opacity ${SKIP_FADE_MS}ms linear` : undefined,
      }}
      onMouseDown={(event) => {
        if (event.button === 0) onSkip()
      }}
      role="status"
      aria-label="Personal Agent 正在启动，单击鼠标左键可跳过"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, transparent 0, transparent 3px, #FFFFFF 4px)',
        }}
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-x-0 h-px bg-white opacity-25"
        style={{ top: `${scanTop}%` }}
        aria-hidden="true"
      />

      <pre className="absolute bottom-5 right-6 m-0 whitespace-pre text-right text-[10px] leading-4 opacity-50">
        {telemetry(streamFrame)}
      </pre>

      <section
        className="relative z-10 m-auto w-[min(780px,72vw)] text-sm leading-6"
        style={{ opacity: logoVisible ? Math.max(0, 1 - logoProgress * 2) : 1 }}
        aria-hidden={logoVisible}
      >
        <pre className="m-0 min-h-[216px] whitespace-pre-wrap font-mono">
          {typeBootCopy(elapsed)}
          <span className="text-white">{cursorVisible ? '█' : ' '}</span>
        </pre>
        {elapsed >= BOOT_TIMING.progressStart ? (
          <div className="mt-6 whitespace-pre text-white">{progressBar(progress, 42)}</div>
        ) : null}
        {elapsed >= BOOT_TIMING.glitchStart ? (
          <div className="mt-3 h-6 whitespace-pre">{glitchLine(streamFrame)}</div>
        ) : null}
      </section>

      <section
        className="absolute inset-x-[6vw] bottom-[12vh] top-[14vh] z-10 flex flex-col items-center justify-center"
        style={{ opacity: logoVisible ? Math.min(1, logoProgress * 2) : 0 }}
        aria-hidden={!logoVisible}
      >
        <div ref={logoWrapRef} className="h-[55vh] w-full overflow-hidden">
          <pre
            ref={logoRef}
            className="m-0 whitespace-pre font-mono leading-none text-white"
            data-boot-logo="true"
          >
            {logo}
          </pre>
        </div>
        <div className="mt-5 h-12 text-center text-xs leading-5">
          {elapsed >= BOOT_TIMING.finalStart ? (
            <>
              <div>{easterEgg}</div>
              <div className="text-white">PERSONAL AGENT READY {cursorVisible ? '█' : ' '}</div>
            </>
          ) : (
            <div>{glitchLine(streamFrame)}</div>
          )}
        </div>
      </section>
    </div>
  )
}
