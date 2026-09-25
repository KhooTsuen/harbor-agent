import { describe, expect, it } from 'vitest'
import { clamp, cn, languageFromName, relativeTime, truncate } from '@/lib/utils'

describe('utils', () => {
  it('cn 保留自定义字号类（tailwind-merge 默认会把 dense/meta 当颜色吞掉）', () => {
    expect(cn('text-dense', 'text-fg-primary')).toBe('text-dense text-fg-primary')
    expect(cn('text-meta leading-relaxed', 'text-fg-tertiary')).toBe(
      'text-meta leading-relaxed text-fg-tertiary',
    )
    /* 两个字号同时出现时，后写的仍然覆盖前一个 */
    expect(cn('text-dense', 'text-meta')).toBe('text-meta')
  })

  it('clamp 夹取数值', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-5, 0, 10)).toBe(0)
    expect(clamp(99, 0, 10)).toBe(10)
  })

  it('truncate 截断并加省略号', () => {
    expect(truncate('hello', 10)).toBe('hello')
    expect(truncate('hello world', 5)).toBe('hell…')
  })

  it('relativeTime 各档位', () => {
    const now = 1_700_000_000_000
    expect(relativeTime(now - 30_000, now)).toBe('刚刚')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 分')
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3 时')
    expect(relativeTime(now - 2 * 24 * 3600_000, now)).toBe('2 天')
    /* 未来时间不出现负数 */
    expect(relativeTime(now + 60_000, now)).toBe('刚刚')
  })

  it('languageFromName 按扩展名判断语言', () => {
    expect(languageFromName('a.ts')).toBe('typescript')
    expect(languageFromName('b.tsx')).toBe('tsx')
    expect(languageFromName('c.py')).toBe('python')
    expect(languageFromName('d.md')).toBe('markdown')
    expect(languageFromName('noext')).toBe('text')
    expect(languageFromName('e.unknown')).toBe('text')
  })
})
