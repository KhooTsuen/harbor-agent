import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TaskRecord } from '@/types/safety'
import { useTaskStore } from '@/stores/useTaskStore'
import { PlanCard, type PlanVersion } from '../PlanCard'
import { PlanBar } from '../composer/PlanBar'
import { execMetaLabel, execSummary, type ExecSummary } from '../taskCenterModel'

/* ══════════════════════════════════════════════════════════════
   PlanCard / PlanBar —— **动态**刷新（2026-10-13）

   为什么单开这一份：`planCard.test.ts` / `planBar.test.tsx` 里的断言都是
   「渲染一次、看一次」—— 它们证明「给定数据能画出正确的行」，**证明不了**
   「刷新时只改文本、不重排」。而后者正是防抖动的全部依据
   （见 `docs/research/plan-card-dynamic-design.md` §3：靠 DOM 稳定，不靠动画）。

   这里让数据**一步步长大**（同一个 root / 同一个 store，模拟真实执行流：
   内核每跑完一个工具就 refresh 一次），逐帧断言三件事：
     · 动态行的文本跟着执行事实变 —— 0→1→9→10→12 每一步都不一样，
       所以这不是恒真断言（组件要是不跟着变，第二帧就红）；
     · 动态行**始终是同一个 DOM 节点** —— 证明是「改文本」而不是「重挂」；
     · 计划那一半**不动**（模型没重发计划块）—— 这才叫「卡死 0/M 被补上了」。

   数据一律走生产同款 `execSummary` / `execMetaLabel`，不手写「差不多」的对象
   （AGENT.md #9：形状只定义一处，夹具也用生产方的那个）。
   ══════════════════════════════════════════════════════════════ */

const PLAN: PlanVersion[] = [{ plan: ['[x] 读现状', '[ ] 改', '[ ] 测'], at: 1, reason: '' }]

/** 照内核记的真实事实形状造 exec（生产里由 `execSummary(task)` 算出） */
function exec(patch: Partial<ExecSummary> = {}): ExecSummary {
  return { steps: 0, ok: 0, failed: 0, checkpoints: 0, files: 0, ...patch }
}

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
  useTaskStore.setState({ tasks: [] })
})

describe('PlanCard / 动态刷新（真渲染 · 只改文本不重排）', () => {
  const draw = (e: ExecSummary): HTMLElement => {
    act(() => root.render(<PlanCard versions={PLAN} exec={e} />))
    return host
  }

  it('★ 执行事实一步步长大：文本每步都变，但动态行始终是同一个 DOM 节点', () => {
    /* 0 步：整行不渲染（不显示「已执行 0 步」） */
    expect(draw(exec()).querySelector('p.tabular-nums')).toBeNull()

    draw(exec({ steps: 1, ok: 1 }))
    const s1 = host.querySelector('p.tabular-nums')
    expect(s1?.textContent).toBe('执行摘要：已执行 1 步')

    draw(exec({ steps: 9, ok: 9 }))
    const s9 = host.querySelector('p.tabular-nums')
    expect(s9?.textContent).toBe('执行摘要：已执行 9 步')

    /* 9 → 10：位数 1→2 的那一跳，tabular-nums 要的就是这一刻不左右抖 */
    draw(exec({ steps: 10, ok: 10 }))
    const s10 = host.querySelector('p.tabular-nums')
    expect(s10?.textContent).toBe('执行摘要：已执行 10 步')

    draw(exec({ steps: 12, ok: 11, failed: 1, files: 2 }))
    const s12 = host.querySelector('p.tabular-nums')
    expect(s12?.textContent).toBe('执行摘要：已执行 12 步（1 次失败） · 已修改 2 个文件')

    /* ★ 核心：几次刷新指向**同一个节点**（不是每次重挂一个），且始终单文本子节点 */
    expect(s9).toBe(s1)
    expect(s10).toBe(s1)
    expect(s12).toBe(s1)
    expect(s12?.childNodes.length).toBe(1)
    expect(s12?.className).toContain('tabular-nums')
  })

  it('★ 用 execSummary(真实台账) 驱动：steps 涨执行数就涨，计划那半仍静态', () => {
    const task = (n: number): TaskRecord =>
      ({
        plan: ['[ ] 一', '[ ] 二'],
        steps: Array.from({ length: n }, (_, i) => ({
          at: i,
          tool: 'run_shell',
          ok: true,
          ms: 1,
          summary: '',
        })),
        changedFiles: [],
      }) as unknown as TaskRecord

    /* 整张卡都由**同一份台账**推出来（versions 也来自它），别再拿顶部的固定 PLAN */
    const show = (n: number): HTMLElement => {
      const t = task(n)
      act(() =>
        root.render(
          <PlanCard versions={[{ plan: t.plan, at: 1, reason: '' }]} exec={execSummary(t)} />,
        ),
      )
      return host
    }

    show(0)
    expect(host.textContent).not.toContain('执行摘要')
    expect(host.textContent).toContain('计划 0/2 步')

    show(3)
    expect(host.textContent).toContain('执行摘要：已执行 3 步')
    /* 计划一条都没勾（模型没重发计划块）→ 静态那半纹丝不动：正是「卡死 0/M」的现场 */
    expect(host.textContent).toContain('计划 0/2 步')

    show(10)
    expect(host.textContent).toContain('执行摘要：已执行 10 步')
    expect(host.textContent).toContain('计划 0/2 步')
  })
})

describe('PlanBar / 动态刷新（store 驱动 · 工具跑完 refresh 那条链）', () => {
  /* PlanBar 从 useTaskStore 读 —— 这条才是真实链：工具跑完 → streamEvents 触发
     refresh → tasks 更新 → 组件订阅刷新。这里就把这条链走一遍。 */
  const taskWith = (n: number, files = 0): TaskRecord =>
    ({
      id: 't1',
      sessionId: 's1',
      updatedAt: 1,
      status: 'running',
      plan: ['[x] 一', '[ ] 二'],
      steps: Array.from({ length: n }, (_, i) => ({
        at: i,
        tool: 'run_shell',
        ok: true,
        ms: 1,
        summary: '',
      })),
      changedFiles: Array.from({ length: files }, (_, i) => ({ path: `f${i}.ts`, at: i })),
      checkpoints: [],
    }) as unknown as TaskRecord

  const push = (n: number, files = 0): void => {
    act(() => useTaskStore.setState({ tasks: [taskWith(n, files)] }))
  }

  const draw = (): HTMLElement => {
    act(() => root.render(<PlanBar threadId="s1" />))
    return host
  }

  it('★ 工具一步步跑完：计划栏那行跟着变，节点不变（改文本而非重挂）', () => {
    push(0)
    draw()
    expect(host.textContent).not.toContain('执行摘要')

    push(1)
    const s1 = host.querySelector('span.tabular-nums')
    expect(s1?.textContent).toContain('执行摘要：已执行 1 步')

    push(10, 2)
    const s10 = host.querySelector('span.tabular-nums')
    expect(s10?.textContent).toContain('执行摘要：已执行 10 步 · 已修改 2 个文件')

    /* ★ 同一个 span（不是重挂），且窄屏降级的那两个类还在 */
    expect(s10).toBe(s1)
    expect(s10?.className).toContain('tabular-nums')
    expect(s10?.className).toContain('truncate')
    /* 计划那半不动 */
    expect(host.textContent).toContain('计划 · 1/2')
  })

  it('★ 数据退化（steps 归零）→ 动态段整段消失，不残留「已执行 0 步」', () => {
    push(3)
    draw()
    expect(host.textContent).toContain('执行摘要：已执行 3 步')
    push(0)
    expect(host.textContent).not.toContain('执行摘要')
  })

  it('★ 措辞与计划卡同源（同一份 execMetaLabel，逐字相同）', () => {
    const e = execSummary(taskWith(4, 1))
    push(4, 1)
    draw()
    expect(host.textContent).toContain(execMetaLabel(e))
  })
})
