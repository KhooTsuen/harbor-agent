import { describe, expect, it } from 'vitest'
import { FONT_OPTIONS, fontStackFor } from '@/constants/fonts'

/* ══════════════════════════════════════════════════════════════
   字体栈

   重点不是「选中的那套写对没有」，而是**任何输入都不能让界面掉到
   浏览器默认字体上** —— 那在中文界面里通常意味着衬线体，很难看。
   ══════════════════════════════════════════════════════════════ */

describe('fontStackFor', () => {
  it('每套内置字体都带中文回退', () => {
    for (const option of FONT_OPTIONS) {
      if (option.id === 'custom') continue
      expect(option.stack.length).toBeGreaterThan(0)
      expect(option.stack).toMatch(/sans-serif/)
    }
  })

  it('系统默认用 system-ui 收尾', () => {
    expect(fontStackFor('system')).toContain('system-ui')
  })

  it('微软雅黑排在首位', () => {
    expect(fontStackFor('yahei').startsWith('"Microsoft YaHei')).toBe(true)
  })

  it('苹方：两个名字都在栈里，雅黑兜底', () => {
    const stack = fontStackFor('pingfang')
    expect(stack.startsWith('"PingFang SC"')).toBe(true)
    /* GDI 只认家族名，全套名会静默回退 —— 两个都写上 */
    expect(stack).toContain('苹方-简')
    expect(stack).toContain('Microsoft YaHei')
  })

  it('SF Pro：Text / Display 两个名字都在，雅黑兜底', () => {
    const stack = fontStackFor('sfpro')
    expect(stack.startsWith('"SF Pro Text"')).toBe(true)
    /* 实测：单写「SF Pro」在 Windows 上认不出来 —— Text / Display 才管用 */
    expect(stack).toContain('"SF Pro Display"')
    expect(stack).toContain('Microsoft YaHei')
  })

  it('苹果字体档只写名字，不带 url()（授权禁止分发字体文件）', () => {
    for (const id of ['pingfang', 'sfpro'] as const) {
      const stack = fontStackFor(id)
      expect(stack).not.toContain('url(')
      expect(stack).not.toMatch(/\.(otf|ttf|woff2?)/i)
    }
  })

  it('自定义：填了名字就用它，并补上兜底', () => {
    const stack = fontStackFor('custom', 'LXGW WenKai')
    expect(stack).toContain('LXGW WenKai')
    expect(stack).toContain('Microsoft YaHei')
  })

  it('自定义：名字带引号也认', () => {
    expect(fontStackFor('custom', '"Some Font"')).toContain('"Some Font"')
    expect(fontStackFor('custom', "'Some Font'")).toContain('"Some Font"')
  })

  it('自定义：空名字回退到系统默认，不会掉到浏览器默认字体', () => {
    const stack = fontStackFor('custom', '   ')
    expect(stack).toBe(fontStackFor('system'))
    expect(stack).toContain('sans-serif')
  })

  it('未知 id 也能拿到兜底', () => {
    /* @ts-expect-error 故意传一个不存在的 id，模拟脏数据 */
    expect(fontStackFor('不存在')).toContain('sans-serif')
  })
})
