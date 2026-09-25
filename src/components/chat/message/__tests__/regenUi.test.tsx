import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AssistantActions } from '../AssistantActions'
import { AnswerVersions } from '../AnswerVersions'
import type { Message } from '@/types'
import type { StoredMessage } from '@/types/models-extra'

/* ══════════════════════════════════════════════════════════════
   重新生成的界面：
     · 正常回复 → 操作条「重新生成」
     · 被中止 / 出错的回复 → 操作条「重试」（语义：试图完成同一目标）
     · 多个回答版本 → ‹ n / N › + 「对比」入口（点开是对比弹窗）

   真渲染（不是源码守卫）—— 这个项目反复踩过「断言到注释里的字」的坑。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

const msg = (over: Partial<Message>): Message => ({
  id: 'a1',
  threadId: 't1',
  role: 'assistant',
  content: '回答',
  kind: 'text',
  status: 'sent',
  timestamp: 1,
  ...over,
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('操作条文案', () => {
  it('正常回复：说「重新生成」', () => {
    act(() => root.render(<AssistantActions message={msg({})} />))
    expect(container.querySelector('button[aria-label="重新生成"]')).toBeTruthy()
  })

  it('★ 被中止的回复：改说「重试」', () => {
    act(() => root.render(<AssistantActions message={msg({ interrupted: true })} />))
    expect(container.querySelector('button[aria-label="重试"]')).toBeTruthy()
    expect(container.querySelector('button[aria-label="重新生成"]')).toBeFalsy()
  })

  it('出错的回复也说「重试」', () => {
    act(() => root.render(<AssistantActions message={msg({ status: 'error', kind: 'error' })} />))
    expect(container.querySelector('button[aria-label="重试"]')).toBeTruthy()
  })
})

describe('版本切换器 + 对比入口', () => {
  const records: StoredMessage[] = [
    { role: 'assistant', key: 'a0', content: '第一版回答\n第二行', answersVersion: 0, ts: 1 },
    { role: 'assistant', key: 'a1', content: '第二版回答', answersVersion: 0, ts: 2 },
  ]

  it('两个回答版本：显示 2 / 2，并给出「对比」按钮', () => {
    act(() =>
      root.render(
        <AnswerVersions
          message={msg({ answerRecords: records, answersVersion: 0, answerIndex: 1 })}
        />,
      ),
    )
    expect(container.textContent).toContain('2 / 2')
    expect(container.querySelector('button[aria-label="对比两次生成"]')).toBeTruthy()
  })

  it('★ 点「对比」：弹出对比弹窗（输出差异 / 工具调用序列 / 文件改动三块都在）', () => {
    act(() =>
      root.render(
        <AnswerVersions
          message={msg({ answerRecords: records, answersVersion: 0, answerIndex: 1 })}
        />,
      ),
    )
    act(() => {
      ;(container.querySelector('button[aria-label="对比两次生成"]') as HTMLButtonElement).click()
    })
    /* Modal 走 portal，断言 document.body */
    expect(document.body.textContent).toContain('对比两次生成')
    expect(document.body.textContent).toContain('最终输出差异')
    expect(document.body.textContent).toContain('工具调用序列')
    expect(document.body.textContent).toContain('文件改动')
  })

  it('只有一版：不显示切换器（没什么可切的）', () => {
    act(() => root.render(<AnswerVersions message={msg({})} />))
    expect(container.textContent).not.toContain('/')
    expect(container.querySelector('button[aria-label="对比两次生成"]')).toBeFalsy()
  })
})
