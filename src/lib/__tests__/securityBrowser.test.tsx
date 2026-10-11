import { createRequire } from 'node:module'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   安全清单 SEC-038：导航后旧元素索引失效

   browse_click 用的是「snapshot 时记下的元素对象身份」核对（见
   `electron/core/browse-ops.cjs` 的 snapCheckSnippet）—— 页面一变，
   第 index 个已经不是那个对象了，点击必须被拒，不能误点。

   这里真在 jsdom 里跑那两段脚本（SNAPSHOT_SCRIPT / clickPointScript），
   而不是抠字符串 —— 清单第 0 节禁止「仅凭源码字符串判定安全」。
   ══════════════════════════════════════════════════════════════ */

const require_ = createRequire(import.meta.url)
const ops = require_(join(process.cwd(), 'electron/core/browse-ops.cjs')) as {
  toIndex: (value: unknown) => number
  clickPointScript: (index: number, force?: boolean) => string
  SNAPSHOT_SCRIPT: string
}

/** 在 jsdom 的窗口上下文里跑一段页面脚本（脚本里的 window/document/location 才在） */
const run = (src: string): Record<string, unknown> =>
  window.eval(src) as Record<string, unknown>

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('SEC-038 导航后旧元素索引失效', () => {
  it('SEC-038 索引 0 是合法索引（不被当成无效）', () => {
    expect(ops.toIndex('0')).toBe(0)
    expect(ops.toIndex(0)).toBe(0)
  })

  it('SEC-038 非法索引被规整成 -1', () => {
    expect(ops.toIndex('-1')).toBe(-1)
    expect(ops.toIndex('1.5')).toBe(-1)
    expect(ops.toIndex('abc')).toBe(-1)
    expect(ops.toIndex(undefined)).toBe(-1)
  })

  it('SEC-038 没读过元素时点击被拒（不误点）', () => {
    document.body.innerHTML = '<button id="b">x</button>'
    const res = run(ops.clickPointScript(0))
    expect(res.ok).toBe(false)
    expect(String(res.error)).toMatch(/browse_elements|页面变了|不存在/)
  })

  it('SEC-038 元素被换掉（模拟导航/重排）后旧索引被拒', () => {
    document.body.innerHTML = '<button id="b">x</button>'
    const snap = run(ops.SNAPSHOT_SCRIPT)
    expect(Array.isArray(snap.items)).toBe(true)
    /* 页面变了：换掉那个元素 */
    document.body.innerHTML = '<button id="c">y</button>'
    const res = run(ops.clickPointScript(0))
    expect(res.ok).toBe(false)
    expect(String(res.error)).toMatch(/页面变了|browse_elements|不存在/)
  })
})
