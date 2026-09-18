import { describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import { Markdown } from '@/components/chat/Markdown'
import { parseBlocks } from '@/lib/markdown'
import { EMPTY_CACHE, parseIncremental, type StableCache } from '@/lib/markdown/incremental'

/* ══════════════════════════════════════════════════════════════
   AG-021：解析 与 渲染 各占多少

   前面那个 benchmark 只量了**解析**（增量快 40~80 倍）。但那回答不了
   一个问题：**解析到底是不是渲染开销的主体？**

   如果不是，那 AG-021 的价值就不在「提升当前手感」，而只在
   「防止超长回复时的 O(n²)」—— 这个区别对用户是有意义的，
   所以这里把两件事分开量：
     · 解析：parseIncremental vs parseBlocks（流式全程累计）
     · 渲染：真实 Markdown 组件在 jsdom 里挂载 + 更新
   ══════════════════════════════════════════════════════════════ */

function makeText(chars: number) {
  const chunk = [
    '## 小标题',
    '',
    '这是一段说明文字，包含 **粗体**、`行内代码` 和 [链接](https://example.com)。',
    '',
    '- 第一条',
    '- 第二条',
    '  - 嵌套一条',
    '',
    '```ts',
    'function hello(name: string) {',
    '  return `hi ${name}`',
    '}',
    '```',
    '',
    '| 列 A | 列 B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
  ].join('\n')
  let out = ''
  while (out.length < chars) out += chunk
  return out.slice(0, chars)
}

describe('AG-021 解析 vs 渲染', () => {
  it('同一次流式：解析花多少、渲染花多少', async () => {
    /*
     * 规模选 2000 字：足够看出两个量级的差别，又不至于把整套测试拖太久。
     * （5000 字那组的数据记在 CHANGELOG 里：解析 265ms / 渲染 1574ms。）
     */
    const text = makeText(2000)
    const batch = 12
    const steps: string[] = []
    for (let i = 0; i <= text.length; i += batch) steps.push(text.slice(0, i))

    /* ── ① 解析：增量 vs 全量 ── */
    let t0 = performance.now()
    let cache: StableCache = EMPTY_CACHE
    for (const s of steps) cache = parseIncremental(s, cache).cache
    const incParse = performance.now() - t0

    t0 = performance.now()
    for (const s of steps) parseBlocks(s)
    const fullParse = performance.now() - t0

    /* ── ② 渲染：真实组件，同一个挂载实例逐步更新 ── */
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    t0 = performance.now()
    for (const s of steps) {
      await act(async () => {
        root.render(createElement(Markdown, { text: s }))
      })
    }
    const render = performance.now() - t0

    /*
     * ── ③ 对照组：同样 417 次渲染，但**每次内容都不变** ──
     *
     * 用来剥离「act / 调度 / jsdom 本身」的固定开销。
     * 如果这一组与上面差不多，说明上面那 1000ms 基本不是渲染的锅，
     * 拿它当基准去优化就是错的方向。
     */
    const frozen = text
    t0 = performance.now()
    for (let i = 0; i < steps.length; i += 1) {
      /* 内容一样（值相同 → React.memo 会跳过） */
      await act(async () => {
        root.render(createElement(Markdown, { text: frozen.slice(0, frozen.length) }))
      })
    }
    const frozenCost = performance.now() - t0

    /* ④ 对照组 2：完全空树，只走 417 次 act —— 纯粹的调度开销 */
    t0 = performance.now()
    for (let i = 0; i < steps.length; i += 1) {
      await act(async () => {
        root.render(null)
      })
    }
    const emptyCost = performance.now() - t0

    await act(async () => root.unmount())
    host.remove()

    console.info(
      `${text.length} 字 / ${steps.length} 次更新：` +
        `全量解析 ${fullParse.toFixed(0)}ms · 增量解析 ${incParse.toFixed(0)}ms · ` +
        `渲染 ${render.toFixed(0)}ms · 内容不变 ${frozenCost.toFixed(0)}ms · 空树 ${emptyCost.toFixed(0)}ms`,
    )

    /* 守卫 ①：增量解析确实比全量快一个量级 */
    expect(incParse).toBeLessThan(fullParse / 3)

    /*
     * 守卫 ②（认知守卫）：**渲染才是大头，解析不是**。
     *
     * 这条断言的意思是：就算把解析优化到 0，也拿不掉主要开销。
     * 所以以后看到「流式卡」不要再往解析上找 —— 去看看尾巴的渲染
     * （最可能是代码块高亮），那是 AG-022 的范围。
     */
    expect(render).toBeGreaterThan(incParse * 5)

    /* 守卫 ③：内容不变时应该几乎不花时间（Block 的 memo 在起作用） */
    expect(frozenCost).toBeLessThan(render / 3)
  }, 60000)
})
