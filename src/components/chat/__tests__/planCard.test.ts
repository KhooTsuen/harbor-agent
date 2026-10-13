import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentStepIndex, isDone, PlanCard, textOf, type PlanVersion } from '../PlanCard'
import type { TaskRecord } from '@/types/safety'
import { execMetaLabel, execSummary, PROGRESS_TITLE, type ExecSummary } from '../taskCenterModel'

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
    /* 详情块拆去了 TaskRowDetails.tsx —— 守卫跟着搬 */
    const src = readFileSync(join(SRC, 'components/chat/TaskRowDetails.tsx'), 'utf8')
    expect(src).toContain('PlanCard')
    expect(src).toContain('planVersions')
  })

  it('★ TaskRecord 里有 planVersions（老任务当空数组看）', () => {
    /* AG-035 把任务相关类型从 safety.ts 拆到了 types/task.ts —— 守卫跟着搬 */
    const src = readFileSync(join(SRC, 'types/task.ts'), 'utf8')
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

/* ══════════════════════════════════════════════════════════════
   PlanCard 动态更新（2026-10-13）：把内核记的**真实执行事实**喂进卡片

   症结：卡上的「计划 N/M 步」只在模型重发计划块时才变 → 不重发就**卡死 0/M**。
   修法是**加法**：加一行「执行摘要：已执行 X 步 · 已修改 Y 个文件」，只读 `execSummary`
   （task.steps / checkpoints / changedFiles）。位置 A（标题行下、步骤列表上）。
   防抖动靠 **DOM 稳定**（恒定单节点 + 只改文本 + tabular-nums），不靠动画。
   设计说明：docs/research/plan-card-dynamic-design.md
   ══════════════════════════════════════════════════════════════ */

const VERSIONS: PlanVersion[] = [{ plan: ['[x] 读现状', '[ ] 改'], at: 1, reason: '' }]
const EXEC: ExecSummary = { steps: 12, ok: 12, failed: 0, checkpoints: 2, files: 3 }

describe('PlanCard / 动态执行摘要（真渲染）', () => {
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

  function draw(props: { versions: PlanVersion[]; exec?: ExecSummary }): HTMLElement {
    act(() => {
      root.render(createElement(PlanCard, props))
    })
    return host
  }

  it('★ 传了 exec → 卡里出现「执行摘要：已执行 12 步 · 已修改 3 个文件」', () => {
    expect(draw({ versions: VERSIONS, exec: EXEC }).textContent).toContain(
      '执行摘要：已执行 12 步 · 已修改 3 个文件',
    )
  })

  it('★ 动态行在标题行之下、步骤列表之上（位置 A）', () => {
    const box = draw({ versions: VERSIONS, exec: EXEC })
    const line = box.querySelector('p.tabular-nums')
    const steps = box.querySelector('ol')
    expect(line?.textContent).toContain('执行摘要')
    /* DOM 顺序：步骤列表出现在动态行**之后**（compareDocumentPosition 的 FOLLOWING 位） */
    const pos = line && steps ? line.compareDocumentPosition(steps) : 0
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('★ steps === 0 → 整行不渲染（不显示「已执行 0 步」，那和卡死的 0/M 一样误导）', () => {
    const text =
      draw({ versions: VERSIONS, exec: { steps: 0, ok: 0, failed: 0, checkpoints: 0, files: 2 } })
        .textContent ?? ''
    expect(text).not.toContain('执行摘要')
  })

  it('没传 exec → 不含该行（老调用点 / 老任务行为与改前一字不差）', () => {
    expect(draw({ versions: VERSIONS }).textContent).not.toContain('执行摘要')
  })

  it('★ 动态行是**恒定单节点**、带 tabular-nums（刷新只改文本，不重排）', () => {
    const box = draw({ versions: VERSIONS, exec: EXEC })
    const lines = box.querySelectorAll('p.tabular-nums')
    expect(lines.length).toBe(1)
    /* 只有一个文本子节点 —— 每次刷新只改它，节点数不变 */
    expect(lines[0].childNodes.length).toBe(1)
    /* 不加 aria-live：每步都播报太吵（无障碍树里也确认一次） */
    expect(lines[0].getAttribute('aria-live')).toBeNull()
  })
})

describe('PlanCard 动态行 / 接线守卫（防「写好了没人调」）', () => {
  const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

  it('★ TaskRowDetails 把 execSummary(task) 传给了 PlanCard（不是只传 versions）', () => {
    expect(readSrc('components/chat/TaskRowDetails.tsx')).toContain(
      '<PlanCard versions={task.planVersions ?? []} exec={execSummary(task)} />',
    )
  })

  it('★ PlanCard 渲染 execMetaLabel 的结果（渲染层真的接上了）', () => {
    expect(readSrc('components/chat/PlanCard.tsx')).toContain('execMetaLabel(exec)')
  })

  it('★ 动态行带 tabular-nums，且**不加** aria-live（每步播报太吵）', () => {
    const src = readSrc('components/chat/PlanCard.tsx')
    expect(src).toContain('tabular-nums')
    /* 看**属性**形式（`aria-live=`），别被注释里提到的字面量骗了 */
    expect(src).not.toContain('aria-live=')
  })

  it('★ 不碰防闪烁三件套（计划卡不引入 useSmoothText / useAutoScroll / scrollGuard）', () => {
    const src = readSrc('components/chat/PlanCard.tsx')
    expect(src).not.toContain('useSmoothText')
    expect(src).not.toContain('useAutoScroll')
    expect(src).not.toContain('scrollGuard')
  })
})

/* ══════════════════════════════════════════════════════════════
   动态行的**措辞层**（execMetaLabel / PROGRESS_TITLE）

   症结：卡上的「计划 N/M 步」只在模型重发计划块时才变 → 不重发就**卡死 0/M**。
   修法是加法：加一行「执行摘要：已执行 X 步 · 已修改 Y 个文件」，只读 `execSummary`
   （task.steps / checkpoints / changedFiles）——不解析自然语言、不建 plan↔工具映射。
   设计说明：docs/research/plan-card-dynamic-design.md
   ══════════════════════════════════════════════════════════════ */

const meta = (patch: Partial<ExecSummary>) =>
  execMetaLabel({ steps: 0, ok: 0, failed: 0, checkpoints: 0, files: 0, ...patch })

describe('PlanCard 动态行 / execMetaLabel（措辞单一真相源）', () => {
  it('★ 步数 + 文件数 → 「执行摘要：已执行 12 步 · 已修改 3 个文件」', () => {
    expect(meta({ steps: 12, ok: 12, files: 3 })).toBe('执行摘要：已执行 12 步 · 已修改 3 个文件')
  })

  it('没改过文件 → 省掉后半段（不写「已修改 0 个文件」）', () => {
    expect(meta({ steps: 5, ok: 5 })).toBe('执行摘要：已执行 5 步')
  })

  it('★ steps === 0 → 空串（调用方据此**整行不渲染**，不显示「已执行 0 步」）', () => {
    expect(meta({ steps: 0, files: 3 })).toBe('')
  })

  it('失败次数沿用 execProgressLabel 的措辞（不另写一套「已执行」）', () => {
    expect(meta({ steps: 2, ok: 1, failed: 1, files: 1 })).toBe(
      '执行摘要：已执行 2 步（1 次失败） · 已修改 1 个文件',
    )
  })

  it('★ 前缀「执行摘要：」在（免得被读成计划的一部分）', () => {
    expect(meta({ steps: 1, ok: 1 }).startsWith('执行摘要：')).toBe(true)
  })

  it('★ 真执行事实：计划一条没勾也照样量得出来（「卡死 0/5」的反例）', () => {
    const exec = execSummary({
      plan: ['[ ] 一'],
      steps: [{ at: 1, tool: 'edit_file', ok: true, ms: 3, summary: 'a' }],
      changedFiles: [{ path: 'a.ts', at: 3 }],
    } as unknown as TaskRecord)
    expect(execMetaLabel(exec)).toBe('执行摘要：已执行 1 步 · 已修改 1 个文件')
  })
})

describe('进度口径说明 / PROGRESS_TITLE', () => {
  it('★ 明写「计划卡中的 [ ] 是模型最初规划时的静态勾选，不代表实际执行进度」', () => {
    expect(PROGRESS_TITLE).toContain(
      '计划卡中的 [ ] 是模型最初规划时的静态勾选，不代表实际执行进度',
    )
  })

  it('仍区分「计划条数」与「已执行步数」两回事', () => {
    expect(PROGRESS_TITLE).toContain('模型不重发计划块就不会变')
    expect(PROGRESS_TITLE).toContain('task.steps')
  })
})
