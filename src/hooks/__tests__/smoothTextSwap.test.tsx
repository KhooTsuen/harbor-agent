import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MessageRound } from '@/types'
import { useSmoothText } from '@/hooks/useSmoothText'
import { ThinkBlock } from '@/components/chat/ProcessBlocks'
import { MessageRounds } from '@/components/chat/message/MessageRounds'

/* ══════════════════════════════════════════════════════════════
   平滑层：**target 换成另一段字符串**时必须重置（P0-1 / P0-3 的回归锁）

   真机上暴露的两个现象，根因是同一个：

     · 任务在跑，但流式内容**冻在某一时刻**不动（用户以为卡死、去强制停止）
     · 流式时同一段内容**显示两遍**，新内容到了第二遍才自己消失

   根因：`useSmoothText` 一直被当成「一段不断变长的文字」用，但调用方
   （`MessageRounds` 的时间线）**每次 `turn_start` 都会递进来另一段字符串**
   （新一轮的 content，从空开始），而组件不重新挂载 —— hook 实例是同一个。
   原来的更新条件是「比长度」（`cur.length < full.length`）：

     · 新 target 更短 → 比不过 → **永远不更新** → 界面冻在上一轮（P0-1）
     · 新 target 更长 → 先把上一轮的字画到新一轮的位置 → 同一段显示两遍（P0-3）

   修法：判据改成**前缀关系**（见 `useSmoothText` 里 `swapped` 那段）。
   这个文件同时钉住两件相反的事，缺一条都不算修好：

     ① 换段了 → 必须立刻换（上面那两个现象）；
     ② 没换段 → **不许动灏平行为**（同一段里追加仍然是逐帧追，不能一下子兜完）。

   ⚠️ 两个受害者都要钉：正文（`MessageRounds`）和思考链（`ThinkBlock`）——
      它们各持一份平滑状态，修一处覆盖两处，但测试必须两处都有。
   ══════════════════════════════════════════════════════════════ */

/** rAF 排队，手动 flush —— 不依赖真实帧率，断语才能稳定 */
let queue: FrameRequestCallback[] = []
const originalRaf = globalThis.requestAnimationFrame

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  queue = []
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    queue.push(cb)) as unknown as typeof globalThis.requestAnimationFrame
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  globalThis.requestAnimationFrame = originalRaf
})

function flush(frames = 40): void {
  for (let i = 0; i < frames; i += 1) {
    const batch = queue
    queue = []
    act(() => {
      for (const cb of batch) cb(0)
    })
  }
}

const read = (): string => container.textContent ?? ''

/** 只把 hook 的返回值印出来（正文那边怎么用不关心） */
function Probe({ target, active }: { target: string; active: boolean }) {
  const shown = useSmoothText(target, active)
  return <span>{shown}</span>
}

const drawProbe = (target: string, active = true): void =>
  act(() => root.render(<Probe target={target} active={active} />))

const roundsOf = (...contents: string[]): MessageRound[] =>
  contents.map((content) => ({ reasoning: '', content, tools: [] }))

const drawRounds = (rounds: MessageRound[]): void =>
  act(() =>
    root.render(
      <MessageRounds rounds={rounds} toolRuns={[]} streaming hideStreamingContent={false} />,
    ),
  )

describe('① 换段了 → 必须立刻换', () => {
  it('★ 新一轮更短：显示新一轮的字，不许冻在上一轮', () => {
    drawProbe('甲'.repeat(300))
    flush()
    expect(read().length).toBe(300)

    /* `turn_start` 推了一轮新的：content 是**另一段**字符串，从空开始长 */
    drawProbe('乙')
    flush()

    expect(read()).toBe('乙')
  })

  it('★ 新一轮持续增长但没超过上一轮：每一批都要看得见（不再冻住）', () => {
    drawProbe('甲'.repeat(300))
    flush()

    /* 每一批都比上一批长（=没冻住），且永远不超过当前 target（=灏平没被破坏）*/
    let last = 0
    for (const len of [10, 30, 60, 120, 200, 280]) {
      drawProbe('丙'.repeat(len))
      flush(20)
      const now = read().length
      expect(now).toBeGreaterThan(last)
      expect(now).toBeLessThanOrEqual(len)
      last = now
    }

    flush(120)
    expect(read()).toBe('丙'.repeat(280))
  })

  it('★ 正文：两轮时间线里，上一轮的字只出现一次（P0-3 就是它显示了两遍）', () => {
    const first = roundsOf('甲'.repeat(300))
    drawRounds(first)
    flush()
    drawRounds([...first, { reasoning: '', content: '乙', tools: [] }])
    flush()

    const text = read()
    expect(text.split('甲').length - 1).toBe(300)
    expect(text).toContain('乙')
  })

  it('★ 思考链：换轮次后「N 字」是新一轮的长度，不是上一轮的', () => {
    act(() => root.render(<ThinkBlock text={'甲'.repeat(300)} streaming />))
    flush()
    expect(read()).toContain('300 字')

    act(() => root.render(<ThinkBlock text={'乙'.repeat(20)} streaming />))
    flush()
    expect(read()).toContain('20 字')
  })
})

describe('② 没换段 → 不许把灏平行为弄丢', () => {
  it('同一段里追加：仍然是逐帧追，不是一下子兜完', () => {
    drawProbe('甲'.repeat(10))
    flush()
    drawProbe('甲'.repeat(300))
    flush(1) /* 只走一帧 */

    const afterOneFrame = read().length
    expect(afterOneFrame).toBeGreaterThan(10)
    expect(afterOneFrame).toBeLessThan(300)
  })

  it('追赶期不能无限滞后：跑够帧数必定追平', () => {
    drawProbe('甲'.repeat(10))
    flush()
    drawProbe('甲'.repeat(3000))
    flush(120)

    expect(read().length).toBe(3000)
  })
})

describe('③ 事件丢失后仍能恢复更新', () => {
  it('★ 中间丢一批（target 直接跳到后面）→ 追平到完整 target', () => {
    drawProbe('甲'.repeat(50))
    flush()
    /* 「丢了一整批」= target 从 50 直接跳到 800，中间那批从没到过 */
    drawProbe('甲'.repeat(800))
    flush(120)

    expect(read().length).toBe(800)
  })

  it('★ 换轮次那一批也丢了（target 跳到另一段更长的新内容）→ 显示完整的新内容', () => {
    drawProbe('甲'.repeat(300))
    flush()
    drawProbe('乙'.repeat(900))
    flush(120)

    const text = read()
    expect(text).toBe('乙'.repeat(900))
    expect(text).not.toContain('甲')
  })
})
