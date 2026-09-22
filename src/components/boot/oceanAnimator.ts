import type { BootScene } from './bootScene'
import { paletteColor, sceneGrid, SCENE_LAYER } from './bootScene'

export type OceanQuality = 'high' | 'medium' | 'low' | 'static'

/* 海面字符（墨量从疏到密；实际选字按它们的真实墨量就近挑，顺序只是给读的人看的） */
const WAVE_CHARS = ' .:;-~=+*#@'

/* 远/中/近三层速度与摆动幅度。远海慢而平，近海快而活。 */
const BANDS = [
  { span: 0.42, speed: 0.045, amplitude: 0.16 },
  { span: 0.34, speed: 0.075, amplitude: 0.24 },
  { span: 0.24, speed: 0.12, amplitude: 0.32 },
] as const

export interface OceanAnimator {
  start: () => void
  stop: () => void
}

function frameInterval(quality: OceanQuality): number {
  if (quality === 'high') return 1000 / 60
  if (quality === 'medium') return 1000 / 30
  return 1000 / 15
}

/**
 * 海面：只动 OCEAN 层的格子，按深度分三层速度。
 *
 * 时间连续的做法（文档 §10 的硬要求）：每个格子的目标墨量是一个
 * **行进波** `sin(x·k − t·speed − y·k)` —— 波是平滑函数，相邻格、
 * 相邻帧都连续；格子只在「目标墨量跨过字符阶梯」的那一刻换字符。
 * 所以不是每帧随机，而是整片水在往一个方向流。
 */
export function createOceanAnimator(
  canvas: HTMLCanvasElement,
  scene: BootScene,
  stride: number,
  quality: OceanQuality,
): OceanAnimator {
  const ctx = canvas.getContext('2d')
  if (!ctx || quality === 'static') return { start: () => {}, stop: () => {} }

  const { cols, rows } = sceneGrid(scene, stride)

  /* 只取样海面有关的格子（层掩码 + 墨量） */
  const waveCov: number[] = []
  for (const ch of WAVE_CHARS) {
    waveCov.push(ch === ' ' ? 0 : scene.coverage[scene.charset.indexOf(ch)])
  }
  const topCoverage = scene.coverage.reduce((a, b) => Math.max(a, b), 0)

  const glyph = new Uint8Array(cols * rows) /* 当前画在屏上的字符 */
  const color = new Uint8Array(cols * rows)
  const oceanRow: number[] = [] /* 每行属于哪个深度带（-1 = 不动） */
  const oceanRowBand: number[] = []

  /* 地平线 = 第一行出现海面 */
  let horizon = rows
  for (let y = 0; y < rows; y += 1) {
    let band = -1
    for (let x = 0; x < cols; x += 1) {
      const source = y * stride * scene.cols + x * stride
      const target = y * cols + x
      glyph[target] = scene.glyph[source]
      color[target] = scene.color[source]
      const layer = scene.layer[source]
      if (layer === SCENE_LAYER.ocean) {
        if (horizon === rows) horizon = y
        band = 0
      } else if (layer === SCENE_LAYER.reflection) {
        band = 0 /* 倒影也跟着水面轻轻动，但幅度另算 */
      }
    }
    oceanRow.push(band)
    oceanRowBand.push(band)
  }
  if (horizon >= rows) return { start: () => {}, stop: () => {} }

  const oceanSpan = rows - horizon
  for (let y = horizon; y < rows; y += 1) {
    if (oceanRow[y] < 0) continue
    const depth = (y - horizon) / oceanSpan
    let acc = 0
    let band = 0
    for (let b = 0; b < BANDS.length; b += 1) {
      acc += BANDS[b].span
      if (depth <= acc || b === BANDS.length - 1) {
        band = b
        break
      }
    }
    oceanRowBand[y] = band
  }

  let handle = 0
  let last = 0
  let time = 0
  const interval = frameInterval(quality)

  const paint = (x: number, y: number, next: number): void => {
    const cell = y * cols + x
    const ch = scene.charset[next]
    glyph[cell] = next
    const px = x * scene.cellW
    const py = y * scene.cellH
    ctx.fillStyle = scene.bg
    ctx.fillRect(px, py, scene.cellW, scene.cellH)
    if (ch !== ' ') {
      ctx.fillStyle = paletteColor(scene, color[cell])
      ctx.fillText(ch, px, py)
    }
  }

  const tick = (now: number): void => {
    if (now - last < interval) {
      handle = requestAnimationFrame(tick)
      return
    }
    last = now
    time += 1

    for (let y = horizon; y < rows; y += 1) {
      if (oceanRow[y] < 0) continue
      const band = BANDS[oceanRowBand[y]]
      for (let x = 0; x < cols; x += 1) {
        const cell = y * cols + x
        const source = y * stride * scene.cols + x * stride
        if (
          scene.layer[source] !== SCENE_LAYER.ocean &&
          scene.layer[source] !== SCENE_LAYER.reflection
        )
          continue

        const base = scene.coverage[scene.glyph[source]]
        const wave = Math.sin(x * 0.16 - time * band.speed * 0.55 + y * 0.5)
        const isReflection = scene.layer[source] === SCENE_LAYER.reflection
        const amp = isReflection ? band.amplitude * 0.5 : band.amplitude
        const target = base + wave * amp * topCoverage

        /* 挑墨量离 target 最近的波字符 —— 目标跨过相邻两字符的中点时才换字符 */
        let best = 0
        let gap = Number.POSITIVE_INFINITY
        for (let w = 0; w < waveCov.length; w += 1) {
          const d = Math.abs(waveCov[w] - target)
          if (d < gap) {
            gap = d
            best = w
          }
        }
        const next = scene.charset.indexOf(WAVE_CHARS[best])
        if (next >= 0 && next !== glyph[cell]) paint(x, y, next)
      }
    }
    handle = requestAnimationFrame(tick)
  }

  return {
    start: () => {
      if (!handle) handle = requestAnimationFrame(tick)
    },
    stop: () => {
      if (handle) cancelAnimationFrame(handle)
      handle = 0
    },
  }
}
