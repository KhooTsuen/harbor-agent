import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/* ══════════════════════════════════════════════════════════════
   GitHub Primer 主题（2026-09-25）

   两层结构：Primer 底层变量（--bg-default / --fg-muted …）
   + Harbor 语义映射（--bg-canvas / --text-primary …）——
   实现在 `src/styles/theme-primer-dark.css`，组件只认识上层。

   这里钉四类东西：
     ① 挂载：index.html 的 data-color-mode + useApplyAppearance 的维护；
     ② 映射存在性：关键语义变量都在映射里（少一个就是「静默失效」）；
     ③ 两个「写了等于没写」的 CSS 坑：
        · 自引用变量（--x: var(--x)）一写，变量在任何地方都失效；
        · Primer 的 --bg-overlay 会顶掉 Modal 的遮罩同名变量；
     ④ 无硬编码颜色扫描：components/、hooks/ 里除白名单外，不许出现
        十六进制色值和内置调色板类（bg-blue-500 / text-white …）。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..')
const themeCss = readFileSync(join(ROOT, 'src', 'styles', 'theme-primer-dark.css'), 'utf8')
const indexCss = readFileSync(join(ROOT, 'src', 'index.css'), 'utf8')
const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
const src = (p: string): string => readFileSync(join(ROOT, 'src', p), 'utf8')

/* ── ① 挂载 ─────────────────────────────────────────────────── */

describe('Primer 主题 / 挂载', () => {
  it('index.html 静态带 data-color-mode="dark"（React 挂载前的兜底）', () => {
    expect(html).toContain('data-color-mode="dark"')
  })

  it('useApplyAppearance 按主题维护 data-color-mode', () => {
    const code = src('hooks/useApplyAppearance.ts')
    expect(code).toContain('dataset.colorMode')
    /* theme=light → light，其余（default / chatgpt / spec / system-dark）→ dark */
    expect(code).toMatch(/colorMode\s*=\s*resolved === 'light' \? 'light' : 'dark'/)
  })
})

/* ── ② 映射存在性 ───────────────────────────────────────────── */

describe('Primer 主题 / 两层映射', () => {
  it('有 dark 底层与 default 主题的映射块', () => {
    expect(themeCss).toContain("[data-color-mode='dark']")
    expect(themeCss).toContain("[data-theme='default'][data-color-mode='dark']")
  })

  it('关键语义变量全部在映射里（少一个就是静默失效）', () => {
    const start = themeCss.indexOf("[data-theme='default'][data-color-mode='dark']")
    expect(start).toBeGreaterThan(-1)
    const map = themeCss.slice(start)
    for (const name of [
      '--bg-canvas',
      '--bg-surface',
      '--bg-raised',
      '--bg-hover',
      '--bg-active',
      '--bg-input',
      '--text-primary',
      '--text-secondary',
      '--text-tertiary',
      '--border-hairline',
      '--border-strong',
      '--cta-bg',
      '--cta-bg-hover',
      '--danger',
      '--success',
      '--warning',
      '--accent-blue',
      '--diff-add',
      '--diff-remove',
    ]) {
      expect(map, `${name} 不在映射里`).toContain(name)
    }
  })

  it('输入框 / 卡片 / hover 档位是约定值（验收 d 的色值）', () => {
    expect(themeCss).toContain('--bg-input: #21262d')
    expect(themeCss).toContain('--bg-raised: #21262d')
    expect(themeCss).toContain('--bg-active: #30363d')
  })

  it('透明度变体的通道值每套主题都齐（Tailwind <alpha-value>，少一个 /NN 就静默失效）', () => {
    for (const name of [
      '--bg-canvas-rgb',
      '--bg-surface-rgb',
      '--bg-raised-rgb',
      '--bg-hover-rgb',
      '--danger-rgb',
    ]) {
      const inIndex = indexCss.split(name).length - 1
      expect(
        inIndex,
        `index.css 里 ${name} 应有 5 份（default / chatgpt / spec / light / night）`,
      ).toBe(5)
    }
    /* 夜航（彩蛋主题）单独钉：双属性选择器才能压过 Primer 的 [data-color-mode='dark'] */
    expect(indexCss).toContain("[data-theme='night'][data-color-mode='dark']")
    expect(indexCss).toContain('--cta-bg: #d29922')
    /* 默认主题（Primer 深色）的通道值必须单独出现在主题文件的映射块里 */
    expect(themeCss).toContain('--bg-raised-rgb: 33 38 45')
    expect(themeCss).toContain('--danger-rgb: 248 81 73')
    /* 配置侧：这 5 个颜色必须走通道模式，否则 /NN 类根本不生成 */
    const tw = readFileSync(join(ROOT, 'tailwind.config.js'), 'utf8')
    expect(tw).toContain('rgb(var(--bg-canvas-rgb) / <alpha-value>)')
    expect(tw).toContain('rgb(var(--bg-raised-rgb) / <alpha-value>)')
    expect(tw).toContain('rgb(var(--danger-rgb) / <alpha-value>)')
  })
})

/* ── ③ 两个真踩过的 CSS 坑 ──────────────────────────────────── */

describe('Primer 主题 / CSS 陷阱', () => {
  it('没有自引用变量（--x: var(--x) 会让变量失效）', () => {
    const selfRef = /--([a-z0-9-]+):\s*var\(--\1\)\s*;/g
    expect(
      [...themeCss.matchAll(selfRef)].map((m) => m[0]),
      'theme-primer-dark.css',
    ).toEqual([])
    expect(
      [...indexCss.matchAll(selfRef)].map((m) => m[0]),
      'index.css',
    ).toEqual([])
  })

  it('Primer 的 --bg-overlay 浮层色不许进主题文件（会和 Modal 遮罩同名打架）', () => {
    expect(themeCss).not.toContain('--bg-overlay: #151b23')
    expect(themeCss).not.toContain('--bg-overlay: #ffffff')
    /* 遮罩本体仍在 index.css 里（深色两档 + 浅色一档） */
    expect(indexCss).toContain('--bg-overlay: rgb(0 0 0 / 0.5)')
    expect(indexCss).toContain('--bg-overlay: rgb(0 0 0 / 0.32)')
  })
})

/* ── 接线守卫：关键组件必须用语义变量 ───────────────────────── */

describe('Primer 主题 / 组件接线', () => {
  it('发送按钮：蓝底（bg-cta）→ hover 变亮（bg-cta-hover），排队按钮 hover 用 accent-hover', () => {
    const code = src('components/chat/composer/SendControls.tsx')
    expect(code).toContain("'bg-cta text-cta-fg hover:bg-cta-hover'")
    expect(code).toContain('hover:bg-accent-hover')
    expect(code).not.toContain('bg-blue-500')
    expect(code).not.toContain('text-white')
  })

  it('侧栏活跃项 / 分支树高亮 / 版本切换器走 accent 变量', () => {
    expect(src('components/layout/sidebar/ThreadRow.tsx')).toContain("active ? 'bg-accent-subtle")
    expect(src('components/layout/sidebar/SidebarBranchTree.tsx')).toContain("'bg-accent-subtle")
    expect(src('components/chat/message/AnswerVersions.tsx')).toContain('border-accent-border')
    expect(src('components/chat/message/UserMessage.tsx')).toContain('border-accent-border')
  })

  it('分叉徽标统一用 --accent（不再有灰色/杂色混用）', () => {
    expect(src('components/chat/branch/ForkBadge.tsx')).toContain('text-accent')
  })

  it('输入框走 --bg-input（Composer / 设置输入 / 消息编辑器）', () => {
    expect(src('components/chat/Composer.tsx')).toContain('bg-bg-input')
    expect(src('components/chat/MessageEditor.tsx')).toContain('bg-bg-input')
    expect(src('components/ui/Field.tsx')).toContain('bg-bg-input')
  })
})

/* ── ④ 无硬编码颜色扫描 ─────────────────────────────────────── */

/*
 * 白名单：每一处都写明理由。「有意保留」和「漏改」长得一样，
 * 所以留给它们的必须是注释里的这句话，不是随手放过。
 */
const ALLOWED: Array<{ path: string; why: string }> = [
  { path: 'components/boot/BootSequence.tsx', why: '启动页夜空场景：固定自绘配色，不属于应用主题' },
  { path: 'components/chat/ImageLightbox.tsx', why: '图片查看的黑遮罩（中性遮罩，无主题语义）' },
  {
    path: 'components/chat/composer/ImageAttachments.tsx',
    why: '附件缩略图的黑遮罩（同上）',
  },
  {
    path: 'components/layout/terminal/XtermTerminal.tsx',
    why: '读主题变量的兜底值（每次读不到变量才会用，已与 Primer 同步）',
  },
  { path: 'hooks/useApplyAppearance.ts', why: '同上：读不到变量时的兜底值' },
]

const HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g
const PALETTE =
  /\b(?:bg|text|border|from|to|via|fill|stroke)-(?:white|black|blue-500|red-500|green-500|slate-\d{2,3}|gray-\d{2,3}|zinc-\d{2,3})\b/g

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue
      out.push(...walk(full))
    } else if (/\.(tsx|ts)$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

describe('Primer 主题 / 无硬编码颜色', () => {
  it('components 与 hooks 里除白名单外没有 hex 色值、没有内置调色板类', () => {
    const hits: string[] = []
    for (const base of ['src/components', 'src/hooks']) {
      for (const file of walk(join(ROOT, base))) {
        const rel = relative(join(ROOT, 'src'), file).replace(/\\/g, '/')
        if (ALLOWED.some((a) => rel === a.path)) continue
        const code = readFileSync(file, 'utf8')
        for (const [name, re] of [
          ['hex', HEX],
          ['palette', PALETTE],
        ] as const) {
          for (const m of code.matchAll(re)) {
            hits.push(`${rel} ${name}: ${m[0]}`)
          }
        }
      }
    }
    expect(hits).toEqual([])
  })
})
