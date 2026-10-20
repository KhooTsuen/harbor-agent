import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

/* ══════════════════════════════════════════════════════════════
   设置页的「分隔规范」

   规范只有一条（定义在 `src/index.css`）：
     .settings-body { gap: 0.5rem }   → 块与块之间 8px

   真实踩过的坑：**组件自己又包了一层没有 gap 的 div**，于是标题与卡片、
   卡片与卡片全部贴在一起（真机量到 0px / 4px）。用户报的就是这个。

   ── 判据为什么用 AST 而不是正则（2026-10-20 教训）──
   第一版用「开标签后 2000 字符内数 Block 组件」的启发式，结果：
     · 把**注释里**举的坏例子当成了违规
     · 把按钮组 / 图标+文字这类**内部小间距**（gap-1、gap-3）当成了块间距
   两条都是假阳性。判据必须只看「容器的**直接子元素**里有几个块」——
   这件事正则做不准，得走 AST。
   ══════════════════════════════════════════════════════════════ */

const ROOT = process.cwd()
const SETTINGS = join(ROOT, 'src', 'components', 'settings')

/** 会自己产生「一块板 / 一个节标题」的组件名 */
const BLOCK_TAGS = new Set(['SectionTitle', 'Row', 'SectionCard', 'RangeRow'])
/** 规范值：.settings-body 的 gap = 0.5rem = 8px */
const SPEC_GAP_PX = 8

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue
      walk(full, out)
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
      out.push(full)
    }
  }
  return out
}

/** 开标签上的 className 字面量 */
function classNameOf(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string {
  for (const prop of opening.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || prop.name.getText() !== 'className') continue
    return prop.initializer ? prop.initializer.getText().replace(/^["'`]|["'`]$/g, '') : ''
  }
  return ''
}

/** 容器**直接子元素**里的设置块（Fragment 展开一层，因为它不带盒子） */
function blocksOf(children: ts.NodeArray<ts.JsxChild>): string[] {
  const names: string[] = []
  for (const child of children) {
    if (ts.isJsxFragment(child)) {
      names.push(...blocksOf(child.children))
      continue
    }
    if (!ts.isJsxElement(child) && !ts.isJsxSelfClosingElement(child)) continue
    const tag = ts.isJsxElement(child)
      ? child.openingElement.tagName.getText()
      : child.tagName.getText()
    if (BLOCK_TAGS.has(tag)) names.push(tag)
  }
  return names
}

/** 从 className 抽间距（px）；没有间距类返回 null */
function gapPxOf(cls: string): number | null {
  const g = cls.match(/\bgap-(\d+(?:\.\d+)?)\b/)
  if (g) return Number(g[1]) * 4
  const sy = cls.match(/\bspace-y-(\d+(?:\.\d+)?)\b/)
  if (sy) return Number(sy[1]) * 4
  return null
}

interface Finding {
  where: string
  blocks: number
  gap: number | null
}

/** 扫全部设置组件：容器直接子元素里有 2+ 个设置块 → 记下它的间距 */
function scan(): Finding[] {
  const findings: Finding[] = []
  for (const file of walk(SETTINGS)) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node)) {
        const tag = node.openingElement.tagName.getText()
        if (tag === 'div' || tag === 'section') {
          const blocks = blocksOf(node.children)
          if (blocks.length >= 2) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
            findings.push({
              where: `${relative(ROOT, file)}:${line}`,
              blocks: blocks.length,
              gap: gapPxOf(classNameOf(node.openingElement)),
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return findings
}

describe('设置页 · 分隔规范', () => {
  it('★ CSS：页首标题的零留白规则不能带子选择器（否则被包裹的标题匹配不到）', () => {
    const css = readFileSync(join(ROOT, 'src', 'index.css'), 'utf8')
    /*
     * 曾经写成 `.settings-body > .settings-section-title:first-child`：
     * 标题被 <div className="...gap-2"> 包一层时就不是直接子元素了，
     * 20px 留白留在页面顶部（真机量到 10 个页面全是 20px）。
     *
     * ★ 判据必须**先剥掉注释**再看 —— 否则本段说明文字里那行坏写法
     *   会把判据自己判红（同一类字面量坑这个项目已踩过两次）。
     */
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).toContain('.settings-section-title:first-child')
    expect(code).not.toMatch(/\.settings-body\s*>\s*\.settings-section-title/)
  })

  it('★ 没有「直接子元素里有 2+ 个设置块却没有间距」的容器', () => {
    const offenders = scan()
      .filter((f) => f.gap === null)
      .map((f) => `${f.where}  子块 ${f.blocks} 个，无间距类`)
    expect(offenders, `这些容器没有间距，标题与卡片会贴在一起：\n${offenders.join('\n')}`).toEqual(
      [],
    )
  })

  it(`★ 块容器的间距只有规范值 ${SPEC_GAP_PX}px（不允许 4px / 6px 各来一套）`, () => {
    const offenders = scan()
      .filter((f) => f.gap !== null && f.gap !== SPEC_GAP_PX)
      .map((f) => `${f.where}  gap=${f.gap}px`)
    expect(
      offenders,
      `块间距应为 ${SPEC_GAP_PX}px（.settings-body 的 0.5rem）：\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
