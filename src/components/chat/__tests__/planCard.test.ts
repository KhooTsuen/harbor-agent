import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDone, textOf } from '../PlanCard'

/* ══════════════════════════════════════════════════════════════
   AG-004：执行计划卡片

   组件的两个纯函数（认不认 [x] / 怎么取正文）要和**内核同口径**：
   内核 `task-context.cjs` 的 `progressOf` 用的就是 `[x]` 标记算完成度，
   两边判断不一致的话，界面上「3/5 步」和内核门禁算的进度会对不上。

   剩下的用**源码守卫**钉接线：这类「两边单独看都对、接错了」的毛病
   单测照不出来（AG-001/AG-002 已经栽过三次）。
   ══════════════════════════════════════════════════════════════ */

const SRC = join(__dirname, '..', '..', '..')

describe('PlanCard / 完成标记', () => {
  it('认小写 [x]', () => {
    expect(isDone('[x] 读配置')).toBe(true)
  })

  it('认大写 [X]', () => {
    expect(isDone('[X] 读配置')).toBe(true)
  })

  it('不认 [ ]', () => {
    expect(isDone('[ ] 读配置')).toBe(false)
  })

  it('不认没标记的条目', () => {
    expect(isDone('读配置')).toBe(false)
  })

  it('不认写在中间的 [x]（只有开头算）', () => {
    expect(isDone('读 [x] 配置')).toBe(false)
  })
})

describe('PlanCard / 取正文', () => {
  it('剥掉 [x]', () => {
    expect(textOf('[x] 读配置')).toBe('读配置')
  })

  it('剥掉 [ ]', () => {
    expect(textOf('[ ] 读配置')).toBe('读配置')
  })

  it('裸条目原样返回', () => {
    expect(textOf('读配置')).toBe('读配置')
  })

  it('多余的空白也清掉', () => {
    expect(textOf('  [x]   读配置  ')).toBe('读配置')
  })
})

describe('PlanCard / 接线守卫', () => {
  it('★ plan 事件会让任务台账重读（不自己维护第二份真相）', () => {
    const src = readFileSync(join(SRC, 'stores/thread/streamEvents.ts'), 'utf8')
    expect(src).toContain("case 'plan'")
    expect(src).toContain('useTaskStore.getState().refresh()')
  })

  it('★ TaskBanner 用 PlanCard 展示计划（不再只给一个「N 步」的数字）', () => {
    const src = readFileSync(join(SRC, 'components/chat/TaskBanner.tsx'), 'utf8')
    expect(src).toContain('PlanCard')
    expect(src).toContain('planVersions')
  })

  it('★ TaskRecord 里有 planVersions（老任务当空数组看）', () => {
    const src = readFileSync(join(SRC, 'types/safety.ts'), 'utf8')
    expect(src).toMatch(/planVersions\?/)
  })
})
