import wordmarkArt from '@/assets/wordmark.txt?raw'
export const BOOT_TIMING = {
  typingEnd: 3200,
  progressStart: 2200,
  progressEnd: 5200,
  glitchStart: 4700,
  logoStart: 5600,
  logoComplete: 7600,
  finalStart: 7500,
  prepareMain: 9000,
  fadeStart: 9400,
  total: 10000,
} as const

export const BOOT_COPY = [
  'HARBOR // LOCAL AGENT SYSTEM',
  '',
  '> mounting local workspace ........ OK',
  '> isolating tool runtime .......... OK',
  '> restoring agent memory .......... OK',
  '> calibrating inference core ...... OK',
  '> mapping cognitive toolchain ..... 128 NODES',
  '> synchronizing context lattice ... STABLE',
  '> verifying human operator ........ PRESENT',
].join('\n')

export const EASTER_EGGS = [
  'Cake Verification Module ... FAILED  //  Reason: Cake is a lie.',
  'Weighted Companion Process ... STILL ALIVE.',
  'Neurotoxin safeguards ... probably enabled.',
] as const

/*
 * 字标：`HARBOR` 的灰度点阵（489 列 × 43 行）。
 *
 * ★ 由 `scripts/generate-wordmark.py` 用系统字体渲染生成 —— 自己算的，
 *   不引用任何现成艺术字（以前那版是《Portal》的 Aperture 图形，公开前移除了）。
 *   手写过一版 5×7 的点阵，缩到屏幕上就一小坨，所以换成这个分辨率。
 */
const ART = wordmarkArt.replace(/^\s*\n/, '').replace(/\s+$/, '')
const NOISE = '@.#%&+?:/\\<>[]{}01'

export function typeBootCopy(elapsed: number): string {
  const count = Math.floor((Math.max(0, elapsed) / BOOT_TIMING.typingEnd) * BOOT_COPY.length)
  return BOOT_COPY.slice(0, Math.min(count, BOOT_COPY.length))
}

export function progressValue(elapsed: number): number {
  const span = BOOT_TIMING.progressEnd - BOOT_TIMING.progressStart
  return Math.round(Math.min(1, Math.max(0, (elapsed - BOOT_TIMING.progressStart) / span)) * 100)
}

export function progressBar(value: number, width = 36): string {
  const filled = Math.round((Math.min(100, Math.max(0, value)) / 100) * width)
  return `[${'█'.repeat(filled)}${'·'.repeat(width - filled)}] ${String(value).padStart(3, '0')}%`
}

function hash(index: number): number {
  let value = Math.imul(index + 17, 0x45d9f3b)
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff
}

export function codeStream(frame: number, rows = 28): string {
  const operations = ['MOUNT', 'VERIFY', 'INDEX', 'ROUTE', 'CACHE', 'DECODE', 'LINK', 'SYNC']
  return Array.from({ length: rows }, (_, row) => {
    const index = row + frame
    const address = Math.floor(hash(index * 13) * 0xffffff)
      .toString(16)
      .toUpperCase()
      .padStart(6, '0')
    const operation = operations[index % operations.length]
    const channel = Math.floor(hash(index * 29) * 256)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0')
    const signal = hash(index * 41) > 0.16 ? 'PASS' : 'RETRY'
    return `0x${address}  ${operation.padEnd(6, ' ')}  CH-${channel}  ${signal}`
  }).join('\n')
}

export function telemetry(frame: number): string {
  const values = Array.from({ length: 8 }, (_, index) => {
    const value = Math.floor(hash(frame + index * 101) * 4096)
    return value.toString(16).toUpperCase().padStart(3, '0')
  })
  return `MEM ${values[0]}  IO ${values[1]}\nCTX ${values[2]}  NET ${values[3]}\nSIG ${values[4]}  AUX ${values[5]}\nLNK ${values[6]}  SYS ${values[7]}`
}

export function glitchLine(frame: number): string {
  const source = 'RECONSTRUCTING VISUAL IDENTITY // SIGNAL LOCK'
  return [...source]
    .map((character, index) => {
      if (character === ' ' || hash(index + frame * 47) > 0.3) return character
      return NOISE[(index * 7 + frame * 11) % NOISE.length]
    })
    .join('')
}

export function reconstructLogo(progress: number, frame: number): string {
  const amount = Math.min(1, Math.max(0, progress))
  if (amount === 1) return ART

  return [...ART]
    .map((character, index) => {
      if (character === ' ' || character === '\n') return character
      const threshold = hash(index)
      if (threshold <= amount) return character
      if (threshold <= amount + 0.06) return NOISE[(index + frame) % NOISE.length]
      return ' '
    })
    .join('')
}

export const COMPLETE_LOGO = ART
