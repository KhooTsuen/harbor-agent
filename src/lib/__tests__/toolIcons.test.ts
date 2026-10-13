import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Globe, FileText, Terminal } from 'lucide-react'
import {
  AGENT_ACTIONS,
  TOOL_ICONS,
  TOOL_LABELS,
  homogeneousIconOf,
  toolIconOf,
} from '../agentActivity'
import type { ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   Phase 7 二期 · 工具图标区分（批次 A）

   要钉死的事实：
     · 图标表达**工具类型**，状态仍由 `colorOf(status)` 表达（这里不测颜色，只在注释里守着）；
     · 认得出工具 → 给对应图标；认不出 → 退回 `Terminal`（不空着、不抛）；
     · 键集合与 `TOOL_LABELS` / `AGENT_ACTIONS` 一致（三张表不许各漏一半）；
     · `homogeneousIconOf`：同类给图标、混合给 null。
   ══════════════════════════════════════════════════════════════ */

const SRC = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

const run = (name: string): ToolRunRecord => ({ id: `r-${name}`, name, ok: true, output: '' })

describe('工具图标映射', () => {
  it('认识的工具给对应图标（不同类型的工具图标不同）', () => {
    expect(toolIconOf('read_file')).toBe(FileText)
    expect(toolIconOf('run_shell')).toBe(Terminal)
    expect(toolIconOf('browse')).toBe(Globe)
    expect(toolIconOf('read_file')).not.toBe(toolIconOf('run_shell'))
  })

  it('★ 未收录的工具退回 Terminal（不空着、不抛）', () => {
    expect(toolIconOf('some_future_tool')).toBe(Terminal)
    expect(toolIconOf('')).toBe(Terminal)
  })

  it('★ 图标表与动作词表 / 人话表覆盖同一批工具（三张表不许各漏一半）', () => {
    expect(Object.keys(TOOL_ICONS).sort()).toEqual(Object.keys(TOOL_LABELS).sort())
    expect(Object.keys(TOOL_ICONS).sort()).toEqual(Object.keys(AGENT_ACTIONS).sort())
  })
})

describe('概览行的同类图标（homogeneousIconOf）', () => {
  it('同族工具 → 给那一枚图标', () => {
    expect(homogeneousIconOf([run('read_file'), run('read_file')])).toBe(FileText)
    /* 浏览族共用 Globe → 不同工具名也算同类 */
    expect(homogeneousIconOf([run('browse_click'), run('browse_type')])).toBe(Globe)
  })

  it('混合类型 → 不给图标（显示不准确的类型比没有更糟）', () => {
    expect(homogeneousIconOf([run('read_file'), run('run_shell')])).toBeNull()
  })

  it('空列表 → null', () => {
    expect(homogeneousIconOf([])).toBeNull()
  })
})

describe('接线守卫（源码级）', () => {
  it('★ 明细行不再恒用 Terminal，改用 toolIconOf', () => {
    const src = read(join('src', 'components', 'chat', 'ToolRuns.tsx'))
    expect(src).toContain('toolIconOf(run.name)')
    /* 旧的恒定图标写法必须已经删掉（防被改回去） */
    expect(src).not.toContain('<Terminal size=')
  })

  it('★ 概览行用 homogeneousIconOf（混合类型不给图标）', () => {
    const src = read(join('src', 'components', 'chat', 'message', 'ToolLine.tsx'))
    expect(src).toContain('homogeneousIconOf(runs)')
  })

  it('★ 图标只表类型：颜色仍只从 statusLanguage 取（不在图标映射里写颜色）', () => {
    const src = read(join('src', 'lib', 'agentActivity.ts'))
    const iconBlock = src.slice(src.indexOf('export const TOOL_ICONS'))
    /* 图标映射块里不该出现任何颜色 token（颜色只归 statusLanguage 管） */
    expect(iconBlock).not.toMatch(/var\(--(success|danger|warning)\)/)
    expect(iconBlock).not.toContain('--accent')
  })
})
