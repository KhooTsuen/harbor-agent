import { describe, expect, it } from 'vitest'
import { RING_COLUMNS, RING_PALETTE, RING_ROWS, renderRing } from '../ringRotator'
import wordmark from '@/assets/banner/wordmark.txt?raw'
import art from '@/assets/aperture.txt?raw'

const LINES = art.replace(/\s+$/, '').split('\n')

describe('Aperture ASCII 横幅', () => {
  it('原始字样尺寸固定', () => {
    expect(LINES).toHaveLength(62)
    const widest = Math.max(...LINES.map((line) => line.length))
    expect(widest).toBeGreaterThan(480)
    expect(widest).toBeLessThan(520)
  })

  it('前景字样独立于光圈，且没有被改坏', () => {
    expect(wordmark.split('\n')).toHaveLength(62)
    expect(wordmark).toContain('@')
    const used = [...new Set(art.replace(/\r?\n/g, ''))].sort().join('')
    expect(used).toBe(' .@')
  })

  it('光圈按 122 x 62 输出', () => {
    const rendered = renderRing(0).split('\n')
    expect(rendered).toHaveLength(RING_ROWS)
    expect(Math.max(...rendered.map((line) => line.length))).toBeLessThanOrEqual(RING_COLUMNS)
  })

  it('用多级密度字符画出边缘，而不是只有实心和空白', () => {
    const used = new Set(renderRing(0).replace(/\r?\n/g, ''))
    expect(used.size).toBeGreaterThanOrEqual(8)
    for (const character of used) expect(RING_PALETTE).toContain(character)
  })

  it('同一角度是确定性的', () => {
    expect(renderRing(37)).toBe(renderRing(37))
  })

  it('任意角度都还有图形（不会转成空帧）', () => {
    for (const angle of [0, 15, 45, 90, 135, 180, 270, 359]) {
      const ink = renderRing(angle).replace(/[\s\r\n]/g, '').length
      expect(ink, `${angle}° 的图形太少了`).toBeGreaterThan(300)
    }
  })
})
