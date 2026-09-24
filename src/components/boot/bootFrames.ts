import wordmarkArt from '@/assets/wordmark.txt?raw'

/* 启动页的时间轴（毫秒）。入场扫出、字标重建、淡出都按它走 */
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

/*
 * 就绪驱动的收尾（README roadmap 那条：「把启动页的时长改成跟着真的就绪走」）。
 *
 * 实测后端 0.25 秒级就绪，而整段动画是 10 秒 —— 于是每次启动都白等近 10 秒。
 * 现在：就绪了就早点收；没就绪就照旧把整段播完（还不行就停在最后一帧等）。
 *
 *   · graceMs —— 最少站住这么久。低于这个数，画面刚出来就走，看着像闪屏
 *   · tailMs   —— 就绪之后再停一拍，然后淡出（淡出占最后 600ms，见 fadeStart→total）
 */
export const BOOT_EXIT = { graceMs: 1500, tailMs: 1200 } as const

/**
 * 这一趟什么时候收尾。
 *
 * @param readyAtMs 就绪发生在启动后的第几毫秒；还没就绪传 null
 */
export function bootExitAt(readyAtMs: number | null): number {
  if (readyAtMs === null || !Number.isFinite(readyAtMs)) return BOOT_TIMING.total
  return Math.min(BOOT_TIMING.total, Math.max(BOOT_EXIT.graceMs, readyAtMs + BOOT_EXIT.tailMs))
}

/*
 * 字标：`HARBOR` 的灰度点阵（489 列 × 43 行）。
 *
 * ★ 由 `scripts/generate-wordmark.py` 用系统字体渲染生成 —— 自己算的，
 *   不引用任何现成艺术字（以前那版是《Portal》的 Aperture 图形，公开前移除了）。
 *   手写过一版 5×7 的点阵，缩到屏幕上就一小坨，所以换成这个分辨率。
 *
 * 港湾夜景的场景画不在这里：它是 `scripts/generate-boot-scene.py` 生成的
 * 数据（`src/assets/boot-scene/scene.b64`），运行时由 `bootScene.ts` 解码绘制。
 */
const ART = wordmarkArt.replace(/^\s*\n/, '').replace(/\s+$/, '')
const NOISE = '@.#%&+?:/=*~-_01'

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

export function glitchLine(frame: number): string {
  const source = 'RECONSTRUCTING VISUAL IDENTITY // SIGNAL LOCK'
  return [...source]
    .map((character, index) => {
      /*
       * 只让大约八分之一的字花掉。以前是 30% —— 整行读起来像乱码，
       * 在安静夜色里太吵；偶尔闪一下才像信号不稳。
       */
      if (character === ' ' || hash(index + frame * 47) > 0.12) return character
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
