import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MessageRounds } from '../message/MessageRounds'
import { PROCESS_RUNNING_LABEL } from '@/lib/processSummary'
import type { MessageRound, ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   运行中入口的「流光」（2026-10-21 用户给的视觉口径）

   这一版的判据不是「好看」，而是**状态必须严格对应**：

     · 运行中（含展开）→ 有流光；文字恒为「实时任务」，不报步骤 / 用时
     · 完成 / 停止 / 失败 → 流光**立即消失**，入口变静态文字
     · 重开历史（没有 streaming）→ 不播动画

   最容易悄悄坏掉的两处，正是这里钉的：
     ① 动画挂到了整行 / 整条消息上（那是「整行忽明忽暗」，用户明确否掉）；
     ② 跑完了类还没摘（旧任务被误显示成「正在运行」）。
   ══════════════════════════════════════════════════════════════ */

const runs = (n: number): ToolRunRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    name: 'read_file',
    ok: true,
    output: 'ok',
    ms: 12,
  }))

/** 33 步的长任务：一轮里连调 33 次，最后一轮出正文 */
const longRounds: MessageRound[] = [
  { reasoning: '先看现状', content: '', tools: Array.from({ length: 33 }, (_, i) => i) },
  { reasoning: '', content: '这是最终回答。', tools: [] },
]

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

function draw(
  roundList: MessageRound[],
  opts: { toolRuns?: ToolRunRecord[]; streaming?: boolean; message?: object } = {},
): HTMLElement {
  act(() => {
    root.render(
      <MessageRounds
        rounds={roundList}
        toolRuns={opts.toolRuns ?? []}
        streaming={opts.streaming ?? false}
        message={opts.message as never}
      />,
    )
  })
  return host
}

const entryOf = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>('button[aria-label="查看过程"]')

/** 入口里那个挂了流光的文字节点（唯一） */
const liveOf = (el: HTMLElement) => el.querySelectorAll('.process-live')

function toggle(el: HTMLElement): void {
  act(() => entryOf(el)?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('运行中：入口有流光，文字恒定', () => {
  it('★★★ 跑着的时候入口挂 .process-live，且文字就是「实时任务」', () => {
    const el = draw(longRounds, { toolRuns: runs(33), streaming: true })
    expect(liveOf(el).length).toBe(1)
    expect(liveOf(el)[0].textContent).toBe(PROCESS_RUNNING_LABEL)
  })

  it('★★★ 流光**只**在入口那一句上，不在整行 / 工具列表 / 正文上', () => {
    const el = draw(longRounds, { toolRuns: runs(33), streaming: true })
    /* 只有一个节点带这个类 —— 多了就是「整片都在动」 */
    expect(liveOf(el).length).toBe(1)
    const live = liveOf(el)[0]
    expect(entryOf(el)?.contains(live)).toBe(true)
    /* 正文段落绝不含它 */
    const bodies = [...el.querySelectorAll('[data-round-body]')]
    expect(bodies.some((b) => b.classList.contains('process-live'))).toBe(false)
  })

  it('★★★ 展开运行中的过程：入口继续流光，内部照常显示真实活动', () => {
    const el = draw(longRounds, {
      toolRuns: [{ id: 'b', name: 'read_file', ok: true, output: '' }],
      streaming: true,
    })
    toggle(el)
    expect(el.querySelector('[data-process-open]')).toBeTruthy()
    expect(liveOf(el).length).toBe(1)
    expect(el.querySelector('[data-process-activity]')).toBeTruthy()
  })

  it('★★ 跑着的时候入口不报步骤数 / 用时（宽度不随过程增长而变）', () => {
    const el = draw(longRounds, { toolRuns: runs(33), streaming: true })
    const text = entryOf(el)?.textContent ?? ''
    expect(text).not.toMatch(/步骤|秒|用时/)
  })
})

describe('结束态：流光立即消失', () => {
  it('★★★ 完成（33 步）→ 没有 .process-live，入口变「33 个步骤」', () => {
    const el = draw(longRounds, { toolRuns: runs(33), message: { durationMs: 31_000 } })
    expect(liveOf(el).length).toBe(0)
    expect(entryOf(el)?.textContent).toBe('33 个步骤')
  })

  it('★★★ 用户停止 → 没有流光，入口写「已中断」', () => {
    const el = draw(longRounds, {
      toolRuns: runs(5),
      message: { interrupted: true, durationMs: 12_000 },
    })
    expect(liveOf(el).length).toBe(0)
    expect(entryOf(el)?.textContent).toBe('已中断')
  })

  it('★★★ 执行失败 → 没有流光，入口写「失败 · N 个步骤」（N 是那一步的条数）', () => {
    /* 33 步里第 2 步失败：入口仍按**实收的工具条数**算，不按轮数 */
    const bad = runs(33).map((r, i) =>
      i === 1 ? { ...r, ok: false, output: '退出码 1：找不到命令' } : r,
    )
    const el = draw(longRounds, { toolRuns: bad, message: { status: 'error' } })
    expect(liveOf(el).length).toBe(0)
    expect(entryOf(el)?.textContent).toBe('失败 · 33 个步骤')
  })

  it('★★★ 重开历史（非流式）→ 不播运行中动画', () => {
    const el = draw(longRounds, { toolRuns: runs(33), message: { durationMs: 31_000 } })
    expect(liveOf(el).length).toBe(0)
    /* 读屏描述也只在运行时挂，历史记录不多一句「实时任务」 */
    expect(entryOf(el)?.hasAttribute('aria-describedby')).toBe(false)
  })
})

describe('无障碍：状态读得到，但不靠动画', () => {
  it('★★ 运行中按钮用 aria-describedby 指向状态文字（读屏能读到「实时任务」）', () => {
    const el = draw([], { streaming: true })
    const entry = entryOf(el)
    const id = entry?.getAttribute('aria-describedby')
    expect(id).toBeTruthy()
    /* useId 生成的 id 带 `:`，CSS 选择器里会被当伪类 —— 用 getElementById 取 */
    expect(document.getElementById(id as string)?.textContent).toBe(PROCESS_RUNNING_LABEL)
  })

  it('★★ 没有 aria-live（文字恒定，不会因动画重复播报）', () => {
    const el = draw([], { streaming: true })
    expect(entryOf(el)?.getAttribute('aria-live')).toBeNull()
    expect(el.querySelector('[aria-live]')).toBeNull()
  })

  it('★★ 事件驱动的动画（CSS），不靠 JS 逐帧改文字 —— 正文节点数恒定', () => {
    const before = draw([], { streaming: true }).querySelectorAll('[data-round-body]').length
    const after = draw(longRounds, { toolRuns: runs(3), streaming: true }).querySelectorAll(
      '[data-round-body]',
    ).length
    expect(before).toBe(0)
    /* 过程从 0 步涨到 3 步，入口那一句仍然只有一个节点 */
    expect(after).toBe(1)
  })
})

describe('CSS 守卫（改回「整行闪烁 / 逐字跳」会红）', () => {
  const css = readFileSync(join(__dirname, '..', '..', '..', 'index.css'), 'utf8')

  it('★ 用 background-clip: text 做文字流光（不是 opacity 呼吸）', () => {
    expect(css).toContain('.process-live {')
    expect(css).toContain('background-clip: text')
  })

  it('★ 周期 2.4s、线性循环（用户要的「2–3 秒扫过一次」）', () => {
    expect(css).toContain('animation: process-live-sweep 2.4s linear infinite')
  })

  it('★ 关动效 / 系统减少动态时把渐变一起撤掉（不留半亮半暗的定格）', () => {
    expect(css).toContain("[data-animations='off'] .process-live")
    expect(css).toMatch(/prefers-reduced-motion[\s\S]{0,200}\.process-live/)
    const off = css.slice(css.indexOf("[data-animations='off'] .process-live"))
    expect(off.slice(0, 300)).toContain('background-image: none')
    expect(off.slice(0, 300)).toContain('-webkit-text-fill-color: currentColor')
  })

  it('★ 没有给入口加发光 / 阴影（光晕会盖过正文）', () => {
    const block = css.slice(
      css.indexOf('.process-live {'),
      css.indexOf('@keyframes process-live-sweep'),
    )
    expect(block).not.toContain('text-shadow')
    expect(block).not.toContain('box-shadow')
  })
})
