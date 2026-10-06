import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SubagentTrace, ToolRunRecord } from '@/types'
import { SubagentCard } from '../SubagentCard'
import { ToolLine } from '../message/ToolLine'

/* ══════════════════════════════════════════════════════════════
   子代理卡（v1）

   为什么要这张卡、以及为什么它不并进工具行，见 `SubagentCard.tsx` 的文件头。
   这里钉三件**用户能不能看见**的事：

     · 卡片真的出现在对话流里（挂在 `spawn_subagent` 那次调用上）
     · 它说清「跑到哪一步了」（进行中 / 完成 / 失败 + 逐条列出）
     · ★ 没有轨迹的老会话**不长出一张空卡**（反向锁：宁可不显示，也别显示假的）

   渲染器是手工搭的（`createRoot` + jsdom）—— 这个项目没有装 testing-library，
   和 `toolLine.test.tsx` 同一套写法。
   ══════════════════════════════════════════════════════════════ */

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

function trace(over: Partial<SubagentTrace> = {}): SubagentTrace {
  return {
    taskId: 'task_child',
    goal: '读 docs/ 下 5 份，每份一句话',
    status: 'running',
    steps: [],
    ...over,
  }
}

function draw(node: React.ReactElement): string {
  act(() => root.render(node))
  return host.textContent ?? ''
}

function spawnRun(over: Partial<ToolRunRecord> = {}): ToolRunRecord {
  return {
    id: 'call_1',
    name: 'spawn_subagent',
    ok: true,
    output: '子代理已完成',
    ms: 13830,
    ...over,
  }
}

describe('子代理卡 / 内容', () => {
  it('标题说人话（「只读子代理」，不是 spawn_subagent）', () => {
    expect(draw(<SubagentCard trace={trace()} />)).toContain('只读子代理')
  })

  it('进行中：说「进行中」，还没调工具时给一句说明（不留空白卡）', () => {
    const text = draw(<SubagentCard trace={trace({ status: 'running' })} />)
    expect(text).toContain('进行中')
    expect(text).toContain('还没开始调工具')
  })

  it('★ 逐条列出子代理每一步（读了哪个文件）', () => {
    const text = draw(
      <SubagentCard
        trace={trace({
          status: 'completed',
          turns: 6,
          steps: [
            {
              id: 's1',
              at: 1,
              tool: 'list_dir',
              args: { path: 'docs' },
              ok: true,
              ms: 7,
              phase: 'completed',
            },
            {
              id: 's2',
              at: 2,
              tool: 'read_file',
              args: { path: 'docs/README.md' },
              ok: true,
              ms: 9,
              phase: 'completed',
            },
          ],
        })}
      />,
    )
    expect(text).toContain('list_dir docs')
    expect(text).toContain('read_file docs/README.md')
    expect(text).toContain('2/2 步')
    expect(text).toContain('6 轮')
  })

  it('失败：说「失败」（不混成完成）', () => {
    expect(draw(<SubagentCard trace={trace({ status: 'failed' })} />)).toContain('失败')
  })

  it('台账 id 露出来（想深看去 data/tasks 找它）', () => {
    expect(draw(<SubagentCard trace={trace()} />)).toContain('task_child')
  })

  it('★ 步数很多时有上限（不把对话铺满）', () => {
    const steps = Array.from({ length: 60 }, (_, i) => ({
      id: `s${i}`,
      at: i,
      tool: 'read_file',
      args: { path: `f${i}.md` },
      ok: true,
      phase: 'completed' as const,
    }))
    const text = draw(<SubagentCard trace={trace({ status: 'completed', steps })} />)
    expect(text).toContain('只显示最近 40 步')
    expect(text).toContain('f59.md')
  })
})

describe('子代理卡 / 接进对话流', () => {
  it('★ 挂在「派只读子代理」那次调用上 → 卡片出现', () => {
    const text = draw(
      <ToolLine
        runs={[
          spawnRun({
            subagent: trace({
              steps: [
                {
                  id: 's1',
                  at: 1,
                  tool: 'read_file',
                  args: { path: 'a.md' },
                  ok: true,
                  phase: 'completed',
                },
              ],
            }),
          }),
        ]}
      />,
    )
    expect(text).toContain('只读子代理')
    expect(text).toContain('read_file a.md')
  })

  it('★ 反向锁：没有轨迹的（老会话 / 别处调）**不长出空卡**', () => {
    /*
     * 判据不能用「只读子代理」那个词 —— 工具行本身的文案就是「派只读子代理」。
     * 用卡片**独有**的标记：「台账：」那行、以及空轨迹的说明句。
     */
    const text = draw(<ToolLine runs={[spawnRun()]} />)
    expect(text).not.toContain('台账：')
    expect(text).not.toContain('还没开始调工具')
    /* 工具行本身照旧 */
    expect(text).toContain('派只读子代理')
  })

  it('★ 反向锁：子代理读到的原文不许出现在卡片里（隔离没破）', () => {
    /*
     * 类型里根本没有 output/result 字段 —— 这条钉的是**将来**：万一有人图省事
     * 把工具输出塞进 SubagentStep，这里会红（会话文件也会跟着被撑爆）。
     */
    const text = draw(
      <SubagentCard
        trace={trace({
          steps: [
            {
              id: 's1',
              at: 1,
              tool: 'read_file',
              args: { path: 'a.md' },
              ok: true,
              phase: 'completed',
            },
          ],
        })}
      />,
    )
    expect(text).not.toContain('SENTINEL-ONLY-IN-FILE')
  })
})
