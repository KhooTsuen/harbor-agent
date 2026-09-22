import { describe, expect, it } from 'vitest'
import {
  BOOT_TIMING,
  glitchLine,
  progressBar,
  progressValue,
  reconstructLogo,
  COMPLETE_LOGO,
} from '../bootFrames'

/*
 * 启动页剩下这几块：进度条、故障行、点阵字标重建。
 *
 * 港湾夜景的 ASCII 场景不在这里 —— 那是 `generate-boot-scene.py` 生成、
 * `bootScene.ts` 解码的数据，测试在 `bootScene.test.ts`。
 */

describe('boot sequence frames', () => {
  it('keeps the complete sequence at about ten seconds', () => {
    expect(BOOT_TIMING.total).toBeGreaterThanOrEqual(9000)
    expect(BOOT_TIMING.total).toBeLessThanOrEqual(12000)
  })

  it('clamps progress and renders a stable-width bar', () => {
    expect(progressValue(0)).toBe(0)
    expect(progressValue(BOOT_TIMING.progressEnd + 5000)).toBe(100)
    const bar = progressBar(50, 20)
    expect(bar).toContain('50%')
    expect(bar).toHaveLength(progressBar(0, 20).length)
  })

  it('glitch 行会变，而且永远是可打印 ASCII', () => {
    const source = 'RECONSTRUCTING VISUAL IDENTITY // SIGNAL LOCK'
    expect(glitchLine(0)).not.toBe(glitchLine(9))
    expect(glitchLine(0)).toHaveLength(source.length)
    /* 花掉的字也必须是可打印 ASCII —— 控制字符/图形块在界面上会变成方块 */
    for (let frame = 0; frame < 60; frame += 1) {
      expect(glitchLine(frame)).toMatch(/^[\x20-\x7E]+$/)
    }
  })

  it('★ 字标是高分辨率点阵（自渲染，够宽够高、只有点阵字符）', () => {
    const rows = COMPLETE_LOGO.split('\u000a')
    /* 手写过一版 5×7 的 —— 缩到屏幕上就一小坨，这里钉住"不许再缩回去" */
    expect(rows.length).toBeGreaterThan(30)
    expect(rows[0].length).toBeGreaterThan(300)
    expect(COMPLETE_LOGO).toMatch(/^[█▓▒░· \u000a]+$/)
    expect(COMPLETE_LOGO).toContain('█')
    /* 重建动画：进度 1 = 完整字标，进度 0 = 还没长出来 */
    expect(reconstructLogo(1, 0)).toBe(COMPLETE_LOGO)
    expect(reconstructLogo(0, 0)).not.toBe(COMPLETE_LOGO)
  })
})
