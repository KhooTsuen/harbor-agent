import { BRAND_NAME } from '@/constants'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import sceneData from '@/assets/boot-scene/scene.b64?raw'
import { BOOT_TIMING, glitchLine, progressBar, progressValue, reconstructLogo } from './bootFrames'
import { loadBootScene, paintBootScene, sceneStride, type BootScene } from './bootScene'
import { createOceanAnimator } from './oceanAnimator'
import { useSettingsStore } from '@/stores/useSettingsStore'

interface BootSequenceProps {
  skipping: boolean
  onSkip: () => void
  onPrepare: () => void
  onDone: () => void
}

const FRAME_INTERVAL = 1000 / 20
const SKIP_FADE_MS = 180
/* 场景自上而下扫出的时长 */
const REVEAL_MS = 2400

export function BootSequence({ skipping, onSkip, onPrepare, onDone }: BootSequenceProps) {
  const [elapsed, setElapsed] = useState(0)
  const [scene, setScene] = useState<BootScene | null>(null)
  const settings = useSettingsStore((state) => state.settings)
  const [systemReducedMotion, setSystemReducedMotion] = useState(false)
  const preparedRef = useRef(false)
  const finishedRef = useRef(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
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

  /* 解码场景数据。失败也不影响启动 —— 底下还有一层夜色渐变兜着 */
  useEffect(() => {
    let alive = true
    loadBootScene(sceneData)
      .then((parsed) => {
        if (alive) setScene(parsed)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setSystemReducedMotion(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!scene || !canvas) return
    const stride = sceneStride(
      scene.cols * scene.cellW,
      window.innerWidth * window.devicePixelRatio,
    )
    paintBootScene(canvas, scene, stride)
    const reduced = systemReducedMotion || settings.asciiReducedMotion || !settings.animations
    const animator = createOceanAnimator(
      canvas,
      scene,
      stride,
      reduced ? 'static' : settings.asciiQuality,
    )
    animator.start()
    return () => animator.stop()
  }, [
    scene,
    settings.asciiQuality,
    settings.asciiReducedMotion,
    settings.animations,
    systemReducedMotion,
  ])

  /*
   * 点阵字标是 489 列宽的一整块 —— 字号必须按容器反推，写死就会换行散架。
   * 先在 100px 上量一遍真实尺寸再等比缩，比猜「等宽字符 ≈ 0.6em」可靠。
   */
  useLayoutEffect(() => {
    const wrap = logoWrapRef.current
    const pre = logoRef.current
    if (!wrap || !pre) return

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
  }, [])

  const progress = progressValue(elapsed)
  const streamFrame = Math.floor(elapsed / 110)
  const cursorVisible = Math.floor(elapsed / 260) % 2 === 0
  const reachedEnd = elapsed >= BOOT_TIMING.finalStart
  const logoProgress =
    (elapsed - BOOT_TIMING.logoStart) / (BOOT_TIMING.logoComplete - BOOT_TIMING.logoStart)
  const logo = reconstructLogo(logoProgress, Math.floor(elapsed / 120))
  const fadeOpacity =
    elapsed >= BOOT_TIMING.fadeStart
      ? 1 - (elapsed - BOOT_TIMING.fadeStart) / (BOOT_TIMING.total - BOOT_TIMING.fadeStart)
      : 1

  return (
    <div
      className="harbor-boot fixed inset-0 z-[90] flex cursor-pointer select-none flex-col overflow-hidden font-mono"
      style={{
        opacity: skipping ? 0 : Math.max(0, fadeOpacity),
        transition: skipping ? `opacity ${SKIP_FADE_MS}ms linear` : undefined,
      }}
      onMouseDown={(event) => {
        if (event.button === 0) onSkip()
      }}
      role="status"
      aria-label={`${BRAND_NAME} 正在启动，单击鼠标左键可跳过`}
    >
      <div
        className="harbor-boot-reveal absolute inset-0"
        style={{
          animationDuration: `${REVEAL_MS}ms`,
          animationPlayState: scene ? 'running' : 'paused',
        }}
      >
        <canvas ref={canvasRef} className="harbor-boot-canvas" aria-hidden="true" />
      </div>

      <div className="relative z-10 flex h-full w-full flex-col px-8 py-7 sm:px-12">
        <header className="flex items-center justify-between text-[10px] uppercase tracking-[0.28em] text-[#c3d8e6]/75">
          <span>Harbor / Local Agent</span>
          <span>Signal {String(progress).padStart(3, '0')}%</span>
        </header>

        <div className="mt-auto flex flex-col gap-3">
          <div
            ref={logoWrapRef}
            className="h-[6vh] max-h-[78px] min-h-[40px] w-[min(430px,38vw)] overflow-hidden"
          >
            <pre
              ref={logoRef}
              className="m-0 whitespace-pre font-mono leading-none text-white/85 transition-opacity duration-700"
              style={{ opacity: elapsed >= BOOT_TIMING.logoStart ? 1 : 0 }}
              data-boot-logo="true"
            >
              {logo}
            </pre>
          </div>

          <div className="text-[11px] uppercase tracking-[0.42em] text-[#bcd4e2]/75">
            A quiet place to begin
          </div>

          <div className="h-5 text-xs tracking-[0.18em] text-[#aac4d4]/75">
            {reachedEnd ? 'LOCAL AGENT · READY' : 'FINDING A CLEAR SIGNAL'}
            <span className="ml-2 text-[#ffeab0]">{cursorVisible ? '●' : '○'}</span>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span className="whitespace-pre text-[11px] tracking-[0.1em] text-[#dbeaf4]/85">
              {progressBar(progress, 26)}
            </span>
            <span className="text-[10px] tracking-[0.12em] text-[#9bb5c8]/70">
              {glitchLine(streamFrame)}
            </span>
          </div>

          <div className="flex items-end justify-end text-[10px] tracking-[0.12em]">
            <span className="text-[#9bb5c8]/65">CLICK TO SKIP</span>
          </div>
        </div>
      </div>
    </div>
  )
}
