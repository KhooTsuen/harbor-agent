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
     · 展开时最多 4 条（多的说「还有 N 条」）
   ══════════════════════════════════════════════════════════════ */

function task(plan: string[], sessionId = 's1'): TaskRecord {
  return { id: 't1', sessionId, plan, updatedAt: 1, status: 'running' } as unknown as TaskRecord
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

  it('折叠时显示进度 + 正在进行的那一步', () => {
    useTaskStore.setState({ tasks: [task(SIX)] })
    const text = draw().textContent ?? ''
    expect(text).toContain('计划 · 2/6')
    expect(text).toContain('正在做：读 package.json 的 version 字段')
    /* 折叠时不该把六条全摊出来 */
    expect(text).not.toContain('顺手修掉明显的错字')
  })

  it('★ 展开最多 4 条，多的说「还有 N 条」', () => {
    useTaskStore.setState({ tasks: [task(SIX)] })
    draw()
    toggle()
    const text = host.textContent ?? ''
    /* 前 4 条在 */
    expect(text).toContain('列出工作目录里的文件')
    expect(text).toContain('用三句话总结')
    /* 第 5、6 条不摊开（6 - 4 = 2 条被收着） */
    expect(text).not.toContain('检查 README 有没有过期描述')
    expect(text).toContain('还有 2 条')
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
