import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageItem } from '../MessageItem'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import type { Message } from '@/types'

/* ══════════════════════════════════════════════════════════════
   编辑一条用户消息

   用户报的 bug：「对话里的『编辑』貌似只是个占位按钮，没有实际功能」。
   根因是它走的是 **`window.prompt`** —— Electron 里根本没有 prompt()，
   静默返回 null，于是点了等于没点。

   所以这里第一条就是**回归守卫**：点「编辑」以后 `window.prompt` 一次都不许被调用，
   同时真的出现一个可编辑的输入框。

   为什么真渲染而不是源码守卫：这个项目反复踩过「断言到注释里的字」的坑
   （把功能删掉、守卫照样绿）。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root
let sent: string[]

const userMessage = (over: Partial<Message> = {}): Message => ({
  id: 'u1',
  threadId: 't1',
  role: 'user',
  content: '把 README 的安装步骤改一下',
  kind: 'text',
  status: 'sent',
  timestamp: 1,
  ...over,
})

const reply: Message = {
  id: 'a1',
  threadId: 't1',
  role: 'assistant',
  content: '好，我分两步做',
  kind: 'text',
  status: 'sent',
  timestamp: 2,
}

function seed(messages: Message[]): void {
  useAppStore.setState({
    activeThreadId: 't1',
    threads: [{ id: 't1', title: '测试', messages, workdir: '' }],
  } as never)
}

function render(message: Message, hasLater = false): void {
  act(() => {
    root.render(<MessageItem message={message} hasLater={hasLater} />)
  })
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (b) => (b.textContent || '').trim() === label,
  ) as HTMLButtonElement | undefined
}

function type(text: string): void {
  const area = container.querySelector('textarea')
  if (!area) throw new Error('没有出现编辑框')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(area, text)
  act(() => {
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  sent = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  seed([userMessage()])
  /* 重发走的是普通发送链路 —— 这里拦住，只断言「发了什么」 */
  useThreadStore.setState({
    sendMessage: (override?: string) => {
      sent.push(override ?? '')
    },
  } as never)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('点「编辑」', () => {
  it('★ 不许再走 window.prompt（Electron 里它永远返回 null，那就是「点了没反应」）', () => {
    const prompt = vi.spyOn(window, 'prompt')
    render(userMessage())
    act(() => button('编辑')?.click())
    expect(prompt).not.toHaveBeenCalled()
  })

  it('★ 真的出现一个带原文的编辑框，光标在末尾', () => {
    render(userMessage())
    act(() => button('编辑')?.click())
    const area = container.querySelector('textarea')
    expect(area).toBeTruthy()
    expect(area?.value).toBe('把 README 的安装步骤改一下')
    expect(area?.getAttribute('aria-label')).toBe('编辑这条消息')
  })

  it('取消按钮收起编辑框，内容不变', () => {
    render(userMessage())
    act(() => button('编辑')?.click())
    act(() => button('取消')?.click())
    expect(container.querySelector('textarea')).toBeFalsy()
    expect(useAppStore.getState().threads[0].messages[0].content).toBe('把 README 的安装步骤改一下')
  })

  it('★ 按 Esc 也取消（不用去够按钮）', () => {
    render(userMessage())
    act(() => button('编辑')?.click())
    const area = container.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('textarea')).toBeFalsy()
  })
})

describe('保存（只改文字）', () => {
  it('★ 改完的文字写回那条消息，并标上「已编辑」', () => {
    render(userMessage())
    act(() => button('编辑')?.click())
    type('把 README 的安装步骤改成一行的')
    act(() => button('保存')?.click())

    const saved = useAppStore.getState().threads[0].messages[0]
    expect(saved.content).toBe('把 README 的安装步骤改成一行的')
    expect(saved.edited).toBe(true)
    expect(container.querySelector('textarea')).toBeFalsy()
  })

  it('不改内容就点保存 → 内容还是原样（不该被清空）', () => {
    render(userMessage())
    act(() => button('编辑')?.click())
    act(() => button('保存')?.click())
    expect(useAppStore.getState().threads[0].messages[0].content).toBe('把 README 的安装步骤改一下')
  })

  it('空白内容不许保存（按钮禁用）', () => {
    render(userMessage())
    act(() => button('编辑')?.click())
    type('   ')
    expect(button('保存')?.disabled).toBe(true)
  })

  it('★ 后面没有别的消息时，不给「保存并重新回答」（没什么可重来的）', () => {
    render(userMessage(), false)
    act(() => button('编辑')?.click())
    expect(button('保存并重新回答')).toBeFalsy()
  })
})

describe('保存并重新回答', () => {
  it('★ 改文字 + 丢掉后面的旧回答 + 用新文字重发', () => {
    seed([userMessage(), reply])
    render(userMessage(), true)
    act(() => button('编辑')?.click())
    type('把 README 的安装步骤改成一行的')
    act(() => button('保存并重新回答')?.click())

    const messages = useAppStore.getState().threads[0].messages
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('把 README 的安装步骤改成一行的')
    expect(sent).toEqual(['把 README 的安装步骤改成一行的'])
  })

  it('后面确实有内容时才出现这个出口，并说明会丢掉什么', () => {
    render(userMessage(), true)
    act(() => button('编辑')?.click())
    expect(button('保存并重新回答')).toBeTruthy()
    expect(container.textContent ?? '').toContain('后面的回复是按旧问题写的')
  })
})
