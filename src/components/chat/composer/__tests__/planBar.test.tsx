import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useTaskStore } from '@/stores/useTaskStore'
import type { TaskRecord } from '@/types/safety'
import { PlanBar } from '../PlanBar'

/* ══════════════════════════════════════════════════════════════
   计划栏（与输入框嵌合）

   用户 2026-09-30 的要求，逐条钉住：
     · 有 plan 才显示（没有就一行都不占）
     · 可折叠
     · 折叠时显示「正在进行的那一步」
     · 展开时把整份计划都摆出来；长了在卡片里滚
       （2026-10-03 改：原来是硬截 4 条 + 「还有 N 条」，长计划看不全）
   ══════════════════════════════════════════════════════════════ */

function task(
  plan: string[],
  sessionId = 's1',
  id = 't1',
  updatedAt = 1,
  /* 2026-10-13：动态执行摘要要读 steps / changedFiles —— 用第 5 个参数带上，
     老调用点（4 个参数）一字不改 */
  extra: Partial<TaskRecord> = {},
): TaskRecord {
  return { id, sessionId, plan, updatedAt, status: 'running', ...extra } as unknown as TaskRecord
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useTaskStore.setState({ tasks: [] })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function draw(sessionId = 's1'): HTMLElement {
  act(() => {
    root.render(<PlanBar threadId={sessionId} />)
  })
  return host
}

function toggle(): void {
  act(() => {
    host.querySelector('button')?.click()
  })
}

const SIX = [
  '[x] 列出工作目录里的文件',
  '[x] 挑一个文件读一下',
  '[ ] 读 package.json 的 version 字段',
  '[ ] 用三句话总结',
  '[ ] 检查 README 有没有过期描述',
  '[ ] 顺手修掉明显的错字',
]

describe('PlanBar', () => {
  it('没有计划 → 一行都不占', () => {
    useTaskStore.setState({ tasks: [] })
    expect(draw().textContent).toBe('')
  })

  it('计划属于别的对话 → 不显示', () => {
    useTaskStore.setState({ tasks: [task(SIX, 'other')] })
    expect(draw('s1').textContent).toBe('')
  })

  it('★ 更新的空任务不会把计划卡顶掉（内核每句话都新建一条空任务）', () => {
    /*
     * 2026-10-08 用户报的「计划卡又不显示了」：内核收到新消息就新建任务
     * （task-resume.cjs，只有「继续」才复用），新任务没有计划 —— 以前按
     * updatedAt 取最新，一开口卡就没了。现在跳过空任务。
     */
    useTaskStore.setState({
      tasks: [task(SIX, 's1', 'old', 100), task([], 's1', 'new', 200)],
    })
    expect(draw().textContent).toContain('计划 · 2/6')
  })

  it('两条都有计划 → 还是取更新的那条（别误伤）', () => {
    useTaskStore.setState({
      tasks: [task(['[ ] 老的一步'], 's1', 'old', 100), task(['[ ] 新的一步'], 's1', 'new', 200)],
    })
    expect(draw().textContent).toContain('正在做：新的一步')
  })

  it('整个会话只有空任务 → 一行都不占', () => {
    useTaskStore.setState({ tasks: [task([], 's1', 'only', 300)] })
    expect(draw().textContent).toBe('')
  })

  it('折叠时显示进度 + 正在进行的那一步', () => {
    useTaskStore.setState({ tasks: [task(SIX)] })
    const text = draw().textContent ?? ''
    expect(text).toContain('计划 · 2/6')
    expect(text).toContain('正在做：读 package.json 的 version 字段')
    /* 折叠时不该把六条全摊出来 */
    expect(text).not.toContain('顺手修掉明显的错字')
  })

  it('★ 展开把整份计划都摆出来，长了在卡片里滚（不再截到 4 条）', () => {
    useTaskStore.setState({ tasks: [task(SIX)] })
    draw()
    toggle()
    const text = host.textContent ?? ''
    /*
     * 2026-10-03 用户报的：「计划卡超过 4 条后不能往下滚」——
     * 以前是硬截前 4 条 + 一句「还有 2 条」，第 5 条起根本看不见，
     * 只能去后台任务里查「到哪一步了」。
     */
    for (const line of SIX) expect(text).toContain(line.replace(/^\[[ x]\] /, ''))
    expect(text).not.toContain('还有 2 条')

    /* 长计划靠**卡片自己滚**看：上限 + overflow + 不把滚轮传给外面的对话列表 */
    const list = host.querySelector('ul')
    const cls = list?.className ?? ''
    expect(cls).toContain('max-h-')
    expect(cls).toContain('overflow-y-auto')
    expect(cls).toContain('overscroll-contain')
  })

  it('计划做完时说「全部完成」', () => {
    useTaskStore.setState({ tasks: [task(['[x] 一', '[x] 二'])] })
    expect(draw().textContent).toContain('全部完成')
  })

  it('列表前缀与勾选标记都不会显示出来（要剥干净）', () => {
    useTaskStore.setState({ tasks: [task(['- [x] 列出文件'])] })
    draw()
    toggle() /* 明细要展开才看得到 */
    const text = host.textContent ?? ''
    expect(text).toContain('列出文件')
    expect(text).not.toContain('[x]')
    expect(text).not.toContain('- [')
  })
})

/* ══════════════════════════════════════════════════════════════
   PlanBar / 动态执行摘要（2026-10-13）

   计划栏（输入框旁、**常显**）才是用户实际盯着「0/5」的位点 —— 计划卡藏在任务详情里
   默认收起。这里用与计划卡**同一份** `execMetaLabel`（措辞只有一处）。
   窄窗口降级是硬要求：多出来的这段**绝不许可撑破输入框旁的布局**。
   ══════════════════════════════════════════════════════════════ */

describe('PlanBar / 动态执行摘要', () => {
  const STEPS = [
    { at: 1, tool: 'read_file', ok: true, ms: 1, summary: 'a' },
    { at: 2, tool: 'edit_file', ok: true, ms: 1, summary: 'b' },
    { at: 3, tool: 'run_shell', ok: true, ms: 1, summary: 'c' },
  ]

  it('★ 有执行事实 → 行里出现「执行摘要：已执行 3 步 · 已修改 1 个文件」', () => {
    useTaskStore.setState({
      tasks: [task(SIX, 's1', 't1', 1, { steps: STEPS, changedFiles: [{ path: 'a.ts', at: 4 }] })],
    })
    const text = draw().textContent ?? ''
    expect(text).toContain('计划 · 2/6')
    expect(text).toContain('执行摘要：已执行 3 步 · 已修改 1 个文件')
  })

  it('★ steps === 0 → 不出现「执行摘要」（不显示「已执行 0 步」）', () => {
    useTaskStore.setState({ tasks: [task(SIX)] })
    expect(draw().textContent).not.toContain('执行摘要')
  })

  it('★ 折叠 / 展开都在（改的是文本，不是结构）', () => {
    useTaskStore.setState({
      tasks: [task(SIX, 's1', 't1', 1, { steps: [STEPS[0]] })],
    })
    draw()
    expect(host.textContent).toContain('执行摘要：已执行 1 步')
    toggle()
    expect(host.textContent).toContain('执行摘要：已执行 1 步')
  })

  it('★ 窄窗口降级：动态段 hidden + 断点 + min-w-0 truncate（撑不破布局）', () => {
    const src = readFileSync(join(__dirname, '..', 'PlanBar.tsx'), 'utf8')
    /* 视口窄于断点 → 整段隐藏；显示时也能自己缩到自己截断 */
    expect(src).toMatch(/hidden[^"']*min-w-0[^"']*truncate[^"']*min-\[\d+px\]:inline/)
    /* 兜底：这一行不许溢出卡片 */
    expect(src).toContain('overflow-hidden')
    /* 收起来之后，内容仍能悬停看到（按钮上的 title） */
    expect(src).toContain('title={PROGRESS_TITLE}')
  })

  it('★ 动态段带 tabular-nums（位数 9→10 不左右跳）', () => {
    const src = readFileSync(join(__dirname, '..', 'PlanBar.tsx'), 'utf8')
    expect(src).toContain('tabular-nums')
  })

  it('★ 复用计划卡的同一份措辞（execMetaLabel），不另写一套「已执行」', () => {
    const src = readFileSync(join(__dirname, '..', 'PlanBar.tsx'), 'utf8')
    expect(src).toContain('execMetaLabel(execSummary(latest))')
  })
})
