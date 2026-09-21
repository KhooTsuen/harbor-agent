import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* ══════════════════════════════════════════════════════════════
   玻璃拟态（磨砂）

   这个文件钉的是**两条真出过事的**规则。两条都不是「好看不好看」，
   而是「写了等于没写」：

   ① 手写 -webkit-backdrop-filter 会把模糊弄没。
      构建时 autoprefixer 会自己加前缀，顺序是 `-webkit-…; …;`（前缀在前）。
      自己再手写一条前缀版，它就落在**后面**，而压缩器把这两条当成同一个
      属性去重、保留最后一条 —— 于是产物里只剩 `-webkit-backdrop-filter`，
      而 Chromium 不认这个前缀名 → **模糊一直是死的**。
      现象：面板只是一块半透明色板，背面内容照样看得清（用户说的「太透」）。
      实测：修之前 `getComputedStyle(el).backdropFilter === 'none'`。

   ② 声明被别人的选择器列表吞掉。
      有人（我）把 `:root { … }` 插进了 `.glass-subtle, .glass-medium, …` 的
      选择器列表中间。CSS 把 `a, b, :root { … }` 当**一条合法规则**，不报错，
      于是「关闭态」那条规则只剩下 :root 里的变量，四个 glass 类**没有背景**。

   所以这里的断言都针对「声明还在不在、够不够」，不针对排版。
   ══════════════════════════════════════════════════════════════ */

const SRC = join(__dirname, '..', '..', '..')
const raw = readFileSync(join(SRC, 'src', 'index.css'), 'utf8')

/** 去注释 + 空白压成单空格：断言不该因为换行/对齐变化就红 */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')

/** 开启态里每一层的填充比例，例：82 */
const onFills = (): number[] =>
  [
    ...css.matchAll(
      /\{ background-color: color-mix\(in srgb, var\(--bg-[a-z]+\) (\d+)%, transparent\)/g,
    ),
  ].map((m) => Number(m[1]))

describe('玻璃：模糊没有被前缀写法弄死', () => {
  it('源码里不许出现 -webkit-backdrop-filter（构建器加的前缀会在前面，手写的会盖掉真声明）', () => {
    expect(css).not.toContain('-webkit-backdrop-filter')
  })

  it('开启态每层都真的带 backdrop-filter', () => {
    const layers = css.match(/backdrop-filter: blur\(/g) ?? []
    // 3 级 + glass-panel + acrylic-card + 3 个回退块
    expect(layers.length).toBeGreaterThanOrEqual(5)
  })
})

describe('玻璃：厚到不透，但还得是玻璃', () => {
  it('每一层填充 ≥ 80%（65% 那种就是「太透」）', () => {
    const fills = onFills()
    expect(fills.length).toBeGreaterThanOrEqual(5)
    for (const n of fills) expect(n).toBeGreaterThanOrEqual(80)
  })

  it('但也不许直接做成一坨实心（≤ 95%，留出「玻璃」的余地）', () => {
    for (const n of onFills()) expect(n).toBeLessThanOrEqual(95)
  })
})

describe('玻璃：磨砂颗粒', () => {
  it('颗粒定义在 :root（质感不分主题）', () => {
    expect(css).toContain('--glass-grain:')
    expect(css).toContain('--glass-grain-size:')
  })

  it('开启态每一层都叠了颗粒，不只是改了个颜色', () => {
    const used = css.match(/background-image: var\(--glass-grain\)/g) ?? []
    expect(used.length).toBeGreaterThanOrEqual(5)
  })

  it('颗粒是 feTurbulence 生成的内联图，不依赖外部文件', () => {
    expect(css).toContain('feTurbulence')
    expect(css).toContain('data:image/svg+xml')
  })
})

describe('玻璃：关闭态 / 回退态也得是一块板', () => {
  it('关闭态：四个 glass 类要有自己的背景（曾经整块丢失，变成全透明）', () => {
    expect(css).toMatch(
      /\.glass-subtle, \.glass-medium, \.glass-strong, \.glass \{ [^}]*background: var\(--bg-surface\)/,
    )
  })

  it('关闭态：侧栏 / 顶栏用 canvas 底色', () => {
    expect(css).toMatch(/\.glass-subtle \{ background: var\(--bg-canvas\)/)
  })

  it('不许把 :root 插进 glass 的选择器列表里（会吞掉那条规则的声明）', () => {
    expect(css).not.toMatch(/\.glass[a-z-]*, :root \{/)
  })

  it('三个回退（无 backdrop-filter / 减少透明度 / 高对比）都有不透明底色 + 关掉模糊', () => {
    const marks = [
      '@supports not (backdrop-filter: blur(1px))',
      '@media (prefers-reduced-transparency: reduce)',
      '@media (prefers-contrast: more)',
    ]
    for (const m of marks) {
      const i = css.indexOf(m)
      expect(i, `找不到回退块：${m}`).toBeGreaterThan(-1)
      const block = css.slice(i, i + 1200)
      expect(block).toContain('background-color: var(--bg-')
      expect(block).toContain('backdrop-filter: none')
    }
  })

  it('减少透明度 / 高对比时不要颗粒（那时越平越好）', () => {
    for (const m of [
      '@media (prefers-reduced-transparency: reduce)',
      '@media (prefers-contrast: more)',
    ]) {
      const i = css.indexOf(m)
      expect(css.slice(i, i + 1200)).toContain('background-image: none')
    }
  })
})
