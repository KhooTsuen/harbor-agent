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
 * 整段完整播放，不再按「就绪」提前收尾（2026-09-26 按用户要求改回）。
 *
 * v1.19 时曾改成就绪驱动的早收尾 —— 后端 0.25 秒级就绪，于是动画被砍到
 * ~2 秒就淡出，字标重建（5.6s 起）那一整段永远播不到；用户看到的就是
 * 「启动动画被跳过了」。现在整段 10 秒完整播放：
 *   · 想快：播放中点击任意处跳过（BootSequence 的 onMouseDown → useBootGate.skipBoot）
 *   · 不想看：外观页关掉「启动动画」——启动层一帧都不渲染（App 层判定）
 */

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
