import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
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

function task(plan: string[], sessionId = 's1', id = 't1', updatedAt = 1): TaskRecord {
  return { id, sessionId, plan, updatedAt, status: 'running' } as unknown as TaskRecord
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
