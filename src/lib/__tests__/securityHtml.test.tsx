import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBlocks, parseInline } from '@/lib/markdown'
import { RawHtmlBlock, RawHtmlInline } from '@/components/chat/markdown/RawHtml'

/* ══════════════════════════════════════════════════════════════
   安全清单 SEC-001 ~ 004：不可信 HTML / Markdown 不获得应用权限

   为什么这几条必须在这里（jsdom + 真渲染器）跑：
   清单第 0 节禁止「仅凭源码字符串判定安全」。渲染层有一条**行内/块级 HTML 直通**
   （`RawHtml.tsx` 的 dangerouslySetInnerHTML，2026-10-08 用户明确要求打开，
   默认开启 `harbor.rawHtml`）。要判它安不安全，只能真把它渲染出来看 DOM。

   本文件负责的断言面：
     · 经 innerHTML 插入的 <script> 不执行（浏览器规范）；
     · **关闭开关后**，onerror / iframe 等不进入 DOM（退化成纯文本）；
     · 危险输入确实被识别为 html 节点（证明测的是真链路，不是空跑）。

   ⚠️ 断言里**不出现**「默认开启时 onerror 会执行」这种把已知取舍写成期望的写法 ——
   默认开启这件事由 `scripts/security/suites/ipc.mjs` 用 `DEFAULT_ENABLED` 源码断言
   如实记为未通过，交给用户决定，不在这里粉饰。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

function draw(node: React.ReactElement): void {
  act(() => root.render(node))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.localStorage.clear()
  delete (globalThis as Record<string, unknown>).__harborPwned
})

describe('SEC-001 原始 HTML 脚本执行隔离', () => {
  it('SEC-001 <script> 经 innerHTML 插入不执行', () => {
    draw(<RawHtmlBlock html={'<script>globalThis.__harborPwned=1</script>'} />)
    expect((globalThis as Record<string, unknown>).__harborPwned).toBeUndefined()
  })

  it('SEC-001 危险输入确实被识别成 html 节点（链路没空跑）', () => {
    const inline = parseInline('前<script>x</script>后')
    expect(inline.some((n) => n.type === 'html')).toBe(true)
    const blocks = parseBlocks('<div onclick="x()">块</div>')
    expect(blocks.some((b) => b.type === 'html')).toBe(true)
  })
})

describe('SEC-002 图片错误事件 XSS', () => {
  it('SEC-002 关闭 rawHtml 后 onerror 不产生可执行元素', () => {
    window.localStorage.setItem('harbor.rawHtml', '0')
    draw(<RawHtmlBlock html={'<img src=x onerror="globalThis.__harborPwned=1">'} />)
    expect(container.querySelector('img')).toBeNull()
    expect((globalThis as Record<string, unknown>).__harborPwned).toBeUndefined()
  })

  it('SEC-002 行内 onerror 在关闭后同样不进 DOM', () => {
    window.localStorage.setItem('harbor.rawHtml', '0')
    draw(<RawHtmlInline html={'<img src=x onerror="globalThis.__harborPwned=1">'} />)
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('SEC-003 iframe / srcdoc 隔离', () => {
  it('SEC-003 关闭 rawHtml 后 iframe/srcdoc 不进入 DOM', () => {
    window.localStorage.setItem('harbor.rawHtml', '0')
    draw(<RawHtmlBlock html={'<iframe srcdoc="<script>1</script>"></iframe>'} />)
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('SEC-003 关闭后原样以文本展示（不是吞掉内容）', () => {
    window.localStorage.setItem('harbor.rawHtml', '0')
    draw(<RawHtmlBlock html={'<iframe src="https://evil.example"></iframe>'} />)
    expect(container.textContent).toContain('<iframe')
  })
})

describe('SEC-004 Markdown / HTML 混合注入', () => {
  it('SEC-004 关闭开关后任何 HTML 都不进 DOM（整块）', () => {
    window.localStorage.setItem('harbor.rawHtml', '0')
    draw(<RawHtmlBlock html={'<svg onload="globalThis.__harborPwned=1"></svg><b>x</b>'} />)
    expect(container.querySelector('svg')).toBeNull()
    expect((globalThis as Record<string, unknown>).__harborPwned).toBeUndefined()
  })
})

describe('SEC-012 UI 与不可信内容隔离', () => {
  /*
   * 不可信消息里塞「伪系统按钮 / 覆盖层」不能变成真的可交互授权元素。
   * 默认（未开 HTML 直通）下，这些只当文本展示，DOM 里没有可点的 button/input。
   */
  it('SEC-012 默认下伪系统按钮不进 DOM', () => {
    draw(<RawHtmlInline html={'<button onclick="globalThis.__harborPwned=1">同意授权</button>'} />)
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('input')).toBeNull()
    expect((globalThis as Record<string, unknown>).__harborPwned).toBeUndefined()
  })

  it('SEC-012 javascript: 链接不被渲染成可点链接', () => {
    const nodes = parseInline('[点我](javascript:alert(1))')
    expect(nodes.some((n) => n.type === 'link')).toBe(false)
  })

  it('SEC-012 默认下 onerror 属性不进入 DOM（开关默认关）', () => {
    draw(<RawHtmlBlock html={'<img src=x onerror="globalThis.__harborPwned=1">'} />)
    expect(container.querySelector('img')).toBeNull()
    expect((globalThis as Record<string, unknown>).__harborPwned).toBeUndefined()
  })
})
