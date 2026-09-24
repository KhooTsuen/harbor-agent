import { describe, expect, it } from 'vitest'
import {
  BOOT_EXIT,
  BOOT_TIMING,
  bootExitAt,
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

  it('★ 就绪驱动的收尾：早早就绪就别等满 10 秒', () => {
    /* 还没就绪 → 播完整段（老行为，慢启动时画面要盖得住） */
    expect(bootExitAt(null)).toBe(BOOT_TIMING.total)
    /* 0.3 秒就绪 → 按最短停留收尾，不是 10 秒 */
    expect(bootExitAt(300)).toBe(BOOT_EXIT.graceMs)
    expect(bootExitAt(0)).toBeGreaterThanOrEqual(BOOT_EXIT.graceMs)
    /* 就绪得晚一点 → 就绪时刻 + 一拍 */
    expect(bootExitAt(2000)).toBe(2000 + BOOT_EXIT.tailMs)
    /* 再晚也不能超过整段长度 */
    expect(bootExitAt(999999)).toBe(BOOT_TIMING.total)
    /* 结果稳定（tick 可能同一毫秒调多次） */
    expect(bootExitAt(2000)).toBe(bootExitAt(2000))
    /* 淡出一整段必须在收尾之前排得下 */
    expect(BOOT_EXIT.tailMs).toBeGreaterThan(BOOT_TIMING.total - BOOT_TIMING.fadeStart)
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
