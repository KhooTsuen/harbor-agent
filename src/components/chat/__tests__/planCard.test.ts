import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentStepIndex, isDone, textOf } from '../PlanCard'

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

  it('★ 任务中心用 PlanCard 展示计划（不再只给一个「N 步」的数字）', () => {
    const src = readFileSync(join(SRC, 'components/chat/TaskRow.tsx'), 'utf8')
    expect(src).toContain('PlanCard')
    expect(src).toContain('planVersions')
  })

  it('★ TaskRecord 里有 planVersions（老任务当空数组看）', () => {
    const src = readFileSync(join(SRC, 'types/safety.ts'), 'utf8')
    expect(src).toMatch(/planVersions\?/)
  })
})

describe('PlanCard / 三态（AG-027）', () => {
  it('★ 当前 = 第一条没勾掉的', () => {
    expect(currentStepIndex(['[x] 读', '[x] 改', '[ ] 测', '[ ] 交'])).toBe(2)
  })

  it('全做完了 → 没有当前', () => {
    expect(currentStepIndex(['[x] 读', '[x] 改'])).toBe(-1)
  })

  it('空计划 → 没有当前', () => {
    expect(currentStepIndex([])).toBe(-1)
  })

  it('★ 不是「第一条 □」——前面勾过、中间漏了一条，当前是漏的那条', () => {
    expect(currentStepIndex(['[x] 读', '[ ] 改', '[x] 测'])).toBe(1)
  })

  it('一条都没勾 → 第一条', () => {
    expect(currentStepIndex(['[ ] 读', '[ ] 改'])).toBe(0)
  })
})

describe('PlanCard / 三态接线守卫', () => {
  it('★ 当前版计划标 ●（历史版本不标）', () => {
    const src = readFileSync(join(SRC, 'components/chat/PlanCard.tsx'), 'utf8')
    expect(src).toMatch(/<PlanSteps plan=\{current\.plan\} markCurrent/)
    /* 历史那处不能带 markCurrent —— 旧版没有「现在」 */
    expect(src).toMatch(/<PlanSteps plan=\{version\.plan\} \/>/)
  })

  it('★ ● 是实心的（不实心就和 ○ 分不出来了）', () => {
    const src = readFileSync(join(SRC, 'components/chat/PlanCard.tsx'), 'utf8')
    expect(src).toContain("fill: 'currentColor'")
  })

  it('★ 时间线上第一条待办是「当前」（不再全是 ○）', () => {
    const src = readFileSync(join(SRC, 'components/chat/ProgressTimeline.tsx'), 'utf8')
    expect(src).toContain("index === 0 ? 'current' : 'todo'")
  })

  it('★ current 与 active 是两个状态（实心点 vs 转圈）', () => {
    const src = readFileSync(join(SRC, 'components/chat/ProgressTimeline.tsx'), 'utf8')
    expect(src).toMatch(/state === 'current'/)
    expect(src).toMatch(/state === 'active'/)
  })

  it('★ `accent` 这个色在 tailwind 里有定义（否则 text-accent 什么也不生成）', () => {
    /* SRC 是 `src/`，tailwind 配置在仓库根 */
    const src = readFileSync(join(SRC, '..', 'tailwind.config.js'), 'utf8')
    expect(src).toContain("accent: 'var(--accent-blue)'")
  })
})
