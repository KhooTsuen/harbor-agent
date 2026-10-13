import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolLine } from '../message/ToolLine'
import type { ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   Phase 7 二期 · 批次 A 的渲染接线（真渲染 + 源码守卫）

   盯三件「改回去了就报红」的事：
     · 概览行**同类工具才**给图标（混合类型不给）—— 真渲染数 svg；
     · 思考块的淡底卡样式（纯 CSS，不许回到左竖线块）；
     · 上下文 tooltip 补了「缓存命中」+「距自动压缩线还差多少」。
   ══════════════════════════════════════════════════════════════ */

const SRC = join(__dirname, '..', '..', '..', '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

const run = (name: string): ToolRunRecord => ({
  id: `r-${name}`,
  name,
  ok: true,
  output: 'ok',
  ms: 3,
})

describe('概览行的同类图标（真渲染）', () => {
  it('★ 同类工具：状态图标 + 类型图标（两个 svg）', () => {
    const html = renderToStaticMarkup(<ToolLine runs={[run('read_file')]} />)
    expect(html.match(/<svg/g)?.length).toBe(2)
  })

  it('★ 混合类型：只给状态图标（不给类型图标，一个 svg）', () => {
    const html = renderToStaticMarkup(<ToolLine runs={[run('read_file'), run('run_shell')]} />)
    expect(html.match(/<svg/g)?.length).toBe(1)
  })
})

describe('思考块淡底卡（源码守卫）', () => {
  const src = read(join('src', 'components', 'chat', 'ProcessBlocks.tsx'))

  it('★ 展开区是淡底卡（rounded + border + bg-bg-raised/40 + px-3 py-2）', () => {
    expect(src).toContain('bg-bg-raised/40')
    expect(src).toContain('px-3 py-2')
    expect(src).toContain('border-line-subtle')
  })

  it('★ 旧的左竖线块写法已删（防改回去）', () => {
    expect(src).not.toContain('border-l-2')
  })

  it('★ 只改了 className：没有给展开区加内联 style（防每帧重渲时结构不稳）', () => {
    /* 思考块流式时每帧重渲，展开区不该再带 style 属性 */
    expect(src).not.toContain("style={{ borderColor: 'var(--border-strong)' }}")
  })
})

describe('上下文 tooltip 增强（源码守卫）', () => {
  const src = read(join('src', 'components', 'chat', 'composer', 'ContextRow.tsx'))

  it('★ 补了缓存命中 token（usage.cached）—— 断言到**代码行**，不只是字符串', () => {
    expect(src).toContain('usage?.cached')
    /* 断言到具体那行模板串，免得只改注释也能蒙混（负向实验教训） */
    expect(src).toContain('`缓存命中 ${cached.toLocaleString()}')
  })

  it('★ 补了「距自动压缩线还差多少」（断言到代码行）', () => {
    expect(src).toContain('autoCompactAt')
    expect(src).toContain('`距自动压缩线还差约 ${remain.toLocaleString()}')
  })

  it('★ 不碰内核：ContextRow 只用 store / 纯函数，不引 IPC', () => {
    expect(src).not.toContain('stats:')
    expect(src).not.toContain('window.api')
  })
})
