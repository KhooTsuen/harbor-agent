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

describe('boot sequence frames', () => {
  it('keeps the complete sequence at about ten seconds', () => {
    expect(BOOT_TIMING.total).toBeGreaterThanOrEqual(9800)
    expect(BOOT_TIMING.total).toBeLessThanOrEqual(10200)
    expect(BOOT_TIMING.prepareMain).toBeLessThan(BOOT_TIMING.fadeStart)
    expect(BOOT_TIMING.fadeStart).toBeLessThan(BOOT_TIMING.total)
  })

  it('types from empty text to the complete boot report', () => {
    expect(typeBootCopy(0)).toBe('')
    expect(typeBootCopy(BOOT_TIMING.typingEnd)).toBe(BOOT_COPY)
  })

  it('clamps progress and renders a stable-width bar', () => {
    expect(progressValue(BOOT_TIMING.progressStart)).toBe(0)
    expect(progressValue(BOOT_TIMING.progressEnd)).toBe(100)
    expect(progressValue(BOOT_TIMING.total)).toBe(100)
    expect(progressBar(0)).toHaveLength(progressBar(100).length)
  })

  it('generates moving code and telemetry streams with stable dimensions', () => {
    expect(codeStream(0).split('\n')).toHaveLength(28)
    expect(codeStream(0)).not.toBe(codeStream(1))
    expect(telemetry(0).split('\n')).toHaveLength(4)
  })

  it('reconstructs the original Aperture artwork exactly', () => {
    expect(reconstructLogo(1, 0)).toBe(COMPLETE_LOGO)
    expect(reconstructLogo(0, 0)).not.toBe(COMPLETE_LOGO)
    expect(COMPLETE_LOGO.split('\n')).toHaveLength(62)
  })
})
