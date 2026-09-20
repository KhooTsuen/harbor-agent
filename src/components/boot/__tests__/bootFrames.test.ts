import { describe, expect, it } from 'vitest'
import {
  BOOT_COPY,
  BOOT_TIMING,
  codeStream,
  progressBar,
  progressValue,
  reconstructLogo,
  telemetry,
  typeBootCopy,
  COMPLETE_LOGO,
} from '../bootFrames'

/*
 * 启动页的每一块：文案逐字打出、进度条、代码流、遥测、字标重建。
 *
 * 字标那条断言值得单说：它原来引用《Portal》里 Aperture 的 ASCII 图
 * （别人的美术，公开前移除了）。现在换成 `scripts/generate-wordmark.py`
 * 用系统字体渲染出来的灰度点阵 —— 断言里钉住"够宽够高"，
 * 因为中间我手写过一版 5×7 的，缩到屏幕上就一小坨，被用户退回来了。
 */

describe('boot sequence frames', () => {
  it('keeps the complete sequence at about ten seconds', () => {
    expect(BOOT_TIMING.total).toBeGreaterThanOrEqual(9000)
    expect(BOOT_TIMING.total).toBeLessThanOrEqual(12000)
  })

  it('types from empty text to the complete boot report', () => {
    expect(typeBootCopy(0)).toBe('')
    expect(typeBootCopy(BOOT_TIMING.typingEnd)).toBe(BOOT_COPY)
    /* 第一行是产品名 —— 改品牌时别把启动页漏了 */
    expect(BOOT_COPY.split('\n')[0]).toContain('HARBOR')
  })

  it('clamps progress and renders a stable-width bar', () => {
    expect(progressValue(0)).toBe(0)
    expect(progressValue(BOOT_TIMING.progressEnd + 5000)).toBe(100)
    const bar = progressBar(50, 20)
    expect(bar).toContain('50%')
    expect(bar).toHaveLength(progressBar(0, 20).length)
  })

  it('generates moving code and telemetry streams with stable dimensions', () => {
    expect(codeStream(0).split('\n')).toHaveLength(28)
    expect(codeStream(0)).not.toBe(codeStream(7))
    expect(telemetry(0).split('\n')).toHaveLength(4)
    expect(telemetry(0)).not.toBe(telemetry(5))
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
