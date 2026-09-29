import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolRunRecord } from '@/types'
import { ToolLine, describeRuns } from '../message/ToolLine'

/* ══════════════════════════════════════════════════════════════
   工具调用**一行说完**（VS Code 那种）

   这一行同时承担两件事：
     · 说清干了什么（单步点名对象：「读取 README.md」）
     · 说清规模（多步按动作归类计数 + 几步 + 几个失败 + 多久）

   以前是「卡片 + 连续同名归组」那一套（`groupRuns` / `ToolRunList`），
   2026-09-30 收敛成这一行 —— 那份归类测试（`toolRuns.test.ts`）跟着搬到这里，
   判据也从「组数」换成了「这一行说了什么」。
   ══════════════════════════════════════════════════════════════ */

let seq = 0
const run = (
  name: string,
  summary?: string,
  patch: Partial<ToolRunRecord> = {},
): ToolRunRecord => ({
  id: `t${(seq += 1)}`,
  name,
  ok: true,
  ms: 10,
  output: '',
  ...(summary ? { summary } : {}),
  ...patch,
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function draw(runs: ToolRunRecord[]): HTMLElement {
  act(() => root.render(<ToolLine runs={runs} />))
  return host
}

/** 点开概览行看明细 */
function expand(): void {
  act(() => {
    for (const button of [...host.querySelectorAll('button[aria-expanded="false"]')]) {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
  })
}

describe('describeRuns（一句话说清干了什么）', () => {
  it('单步：动词 + 对象（比「读取 1 个文件」有信息量得多）', () => {
    expect(describeRuns([run('read_file', 'README.md')])).toBe('读取 README.md')
  })

  it('单步但没有参数 → 退回工具的人话名字（不编）', () => {
    expect(describeRuns([run('read_file')])).toBe('读取文件')
  })

  it('单步的长参数要截，别把一行撑爆', () => {
    const long = 'a'.repeat(80)
    const text = describeRuns([run('read_file', long)])
    expect(text.length).toBeLessThan(60)
    expect(text.endsWith('…')).toBe(true)
  })

  it('★ 多步：同动作合并计数', () => {
    expect(describeRuns([run('read_file'), run('read_file'), run('read_file')])).toBe(
      '读取 3 个文件',
    )
  })

  it('★ 多步：不同动作分别报，顺序是第一次出现的顺序', () => {
    expect(describeRuns([run('read_file'), run('run_shell')])).toBe('读取 1 个文件、运行 1 条命令')
  })

  it('★ 类别太多只列 3 类，剩下的说「等 N 类」（不假装只有这些）', () => {
    const runs = [run('read_file'), run('run_shell'), run('list_dir'), run('search_web')]
    const text = describeRuns(runs)
    expect(text).toContain('等 4 类')
    expect(text.startsWith('读取 1 个文件、运行 1 条命令、查看 1 个目录')).toBe(true)
  })

  it('空输入 → 空字符串', () => {
    expect(describeRuns([])).toBe('')
  })
})

describe('ToolLine（一行摘要 + 可展开的明细）', () => {
  it('★ 收起时只有一行（没有卡片边框、没有第二层）', () => {
    const el = draw([run('read_file', 'a.md'), run('run_shell', 'npm test')])
    expect(el.querySelectorAll('button')).toHaveLength(1)
    expect(el.textContent).toContain('读取 1 个文件、运行 1 条命令')
  })

  it('★ 多步时把「几步」报出来（VS Code 那行 Completed N steps）', () => {
    const el = draw([run('read_file'), run('read_file')])
    expect(el.textContent).toContain('2 步')
  })

  it('★ 失败要单独报个数 —— 只把图标变红，用户不知道错了几条', () => {
    const el = draw([
      run('read_file'),
      run('run_shell', 'bad', { ok: false, ms: 5 }),
      run('run_shell', 'worse', { ok: false, ms: 5 }),
    ])
    expect(el.textContent).toContain('2 个失败')
  })

  it('展开才有明细行；每行是具体那个工具', () => {
    const el = draw([run('read_file', 'a.md'), run('run_shell', 'npm test')])
    expect(el.textContent).not.toContain('npm test')
    expand()
    expect(host.textContent).toContain('npm test')
    expect(host.textContent).toContain('a.md')
  })

  it('★ 明细有上限，超出的要说「没摊开」（一万步全摊开是几秒白屏）', () => {
    const many = Array.from({ length: 120 }, () => run('read_file'))
    draw(many)
    expand()
    expect(host.textContent).toContain('没摊开')
  })

  it('一条都没有 → 什么都不画（不留空白块）', () => {
    const el = draw([])
    expect((el.textContent ?? '').trim()).toBe('')
  })
})
