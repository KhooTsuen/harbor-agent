import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageItem } from '../MessageItem'
import type { Message, StoredClarify } from '@/types'
import { useAppStore } from '@/stores/useAppStore'

/* ══════════════════════════════════════════════════════════════
   只读卡**什么时候**出现

   用户报的（2026-10-03）：「澄清卡答完，卡还在」。
   真机复现（隔离副本 + 假模型）查清了两件相反的事：

     · 交互卡确实收了，工具那行也不再显示「正在询问」，
       主进程日志是 `[澄清卡] 回话 … ok=true`（不是「落到已结算的 id 上」）；
     · **但只读卡立刻出现** —— 它记在「这一轮的助手消息」上，而回话是
       流式中途落的，所以它当场就出现在正在逐字生成的那条正文最上面。
       用户刚答完，原地又冒出一张长得挺像的卡 → 读起来就是「卡还在」。

   所以判据是：**这一轮还没写完时不显示，写完再显示**。
   这里真的挂载、真的查文字（这个项目踩过「守卫断言到注释里的字」的坑）。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

const STORED: StoredClarify = {
  questions: [
    {
      question: '白板用哪种坐标系？',
      options: [
        { label: '屏幕像素', effect: '改窗口尺寸要重算' },
        { label: '文档坐标', effect: '缩放平移不用改数据' },
      ],
      allowFreeform: true,
      defaultValue: '屏幕像素',
      defaultFrom: 'model',
    },
  ],
  answers: [{ question: '白板用哪种坐标系？', choice: '屏幕像素', text: '' }],
  skipped: false,
}

function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    threadId: 't1',
    role: 'assistant',
    content: '收到，按你选的开工。',
    kind: 'text',
    status: 'sent',
    timestamp: 1,
    ...over,
  }
}

function render(message: Message): void {
  act(() => root.render(<MessageItem message={message} />))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useAppStore.setState({
    activeThreadId: 't1',
    threads: [{ id: 't1', title: '测试', messages: [makeMessage()], workdir: '' }],
  } as never)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('只读卡（开工前问过什么）', () => {
  it('★ 这一轮还在写的时候**不显示**（不然就像「答完卡还在」）', () => {
    render(makeMessage({ status: 'streaming', clarify: STORED }))
    const text = container.textContent ?? ''
    expect(text).not.toContain('开工前问过这几个问题')
    /* 正文照旧流式显示 —— 别为了藏卡把正文也藏了 */
    expect(text).toContain('按你选的开工')
  })

  it('★ 这一轮写完之后显示，而且标出他选的是哪个', () => {
    render(makeMessage({ clarify: STORED }))
    const text = container.textContent ?? ''
    expect(text).toContain('开工前问过这几个问题')
    expect(text).toContain('屏幕像素（已选）')
    /* 没选的那些也要在（回看时得看见当时还有哪些路可走） */
    expect(text).toContain('文档坐标')
  })

  it('超时替他定的那种，标的是「默认」而不是「已选」', () => {
    const auto: StoredClarify = { ...STORED, answers: [], skipped: true, auto: 'timeout' }
    render(makeMessage({ clarify: auto }))
    const text = container.textContent ?? ''
    expect(text).toContain('屏幕像素（默认）')
    expect(text).not.toContain('（已选）')
  })

  it('老记录（没有 clarify 字段）什么都不多渲染', () => {
    render(makeMessage())
    expect(container.textContent ?? '').not.toContain('开工前问过这几个问题')
  })

  /*
   * ★ 2026-10-04（小尾巴 #7）：把「什么时候显示」的路径都钉住。
   *
   * `sent` / `undefined`（老记录）→ 显示；`streaming` → 不显示（上面那条）。
   *
   * ⚠️ `error` 是**既有行为、不是本次修的**：`MessageItem` 对 error 那条走的是
   * 「只画错误块」的分支，整条时间线（包括只读卡）都不渲染 —— 也就是说
   * 「答了卡、但这一轮最终失败」时，回看只能看到错误，看不到当时答了什么。
   * 它属于「卡少了」而不是「卡过早」，不在本次范围；这里先钉住现状，
   * 免得以后有人以为它已经修好了。
   */
  it('非流式收尾：sent / 老记录显示；error 走错误块（既有行为）', () => {
    render(makeMessage({ status: 'sent', clarify: STORED }))
    expect(container.textContent ?? '').toContain('开工前问过这几个问题')

    render(makeMessage({ status: undefined, clarify: STORED }))
    expect(container.textContent ?? '').toContain('开工前问过这几个问题')

    render(makeMessage({ status: 'error', clarify: STORED }))
    expect(container.textContent ?? '').not.toContain('开工前问过这几个问题')
  })

  it('★ 连着三张卡各记各的（同一会话里不串味）', () => {
    const cards = [1, 2, 3].map((n) => ({
      id: `m${n}`,
      threadId: 't1',
      role: 'assistant' as const,
      content: `第 ${n} 轮`,
      kind: 'text' as const,
      status: 'sent' as const,
      timestamp: n,
      clarify: {
        questions: [
          {
            question: `第${n}轮问的问题`,
            options: [
              { label: `第${n}轮的选项甲`, effect: '甲' },
              { label: `第${n}轮的选项乙`, effect: '乙' },
            ],
            allowFreeform: false,
            defaultValue: `第${n}轮的选项甲`,
            defaultFrom: 'model' as const,
          },
        ],
        answers: [{ question: `第${n}轮问的问题`, choice: `第${n}轮的选项乙`, text: '' }],
        skipped: false,
      },
    }))
    act(() => {
      root.render(
        <div>
          {cards.map((m) => (
            <MessageItem key={m.id} message={m} />
          ))}
        </div>,
      )
    })
    const text = container.textContent ?? ''
    for (const n of [1, 2, 3]) {
      /* 自己的问题、自己的答案各出现一次 */
      expect(text.split(`第${n}轮问的问题`).length - 1).toBe(1)
      expect(text.split(`第${n}轮的选项乙（已选）`).length - 1).toBe(1)
      /* 别人的答案不许出现在自己这张卡上 */
      for (const other of [1, 2, 3].filter((x) => x !== n)) {
        expect(text.split(`第${other}轮的选项乙（已选）`).length - 1).toBe(1)
      }
    }
    expect(text.split('开工前问过这几个问题').length - 1).toBe(3)
  })
})
