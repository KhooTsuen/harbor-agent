import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageItem } from '../MessageItem'
import type { Message } from '@/types'
import { useAppStore } from '@/stores/useAppStore'

/* ══════════════════════════════════════════════════════════════
   「这条回复没写完」

   为什么真渲染而不是源码守卫：这个项目反复踩过「守卫断言到注释里的字」的坑
   （把提示整段删掉，守卫照样绿）。这里真的挂载、真的找那段文字。

   ⚠️ 顺带一提：这个文件里也**只能**查文字 —— 看不到排版好不好看，
      那得靠真机截图。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    threadId: 't1',
    role: 'assistant',
    content: '好，我分两步做：先读 README，再改成一行脚本',
    kind: 'text',
    status: 'sent',
    timestamp: 1,
    ...over,
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  /* 消息里有「分支」按钮会动到 store —— 给个最小可用的线程 */
  useAppStore.setState({
    activeThreadId: 't1',
    threads: [{ id: 't1', title: '测试', messages: [makeMessage()], workdir: '' }],
  } as never)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(message: Message): void {
  act(() => root.render(<MessageItem message={message} />))
}

describe('被中断的回复', () => {
  it('★ 说一句「这条没写完」，并指出可以接着做', () => {
    render(makeMessage({ interrupted: true }))
    const text = container.textContent ?? ''
    expect(text).toContain('这条回复没写完')
    expect(text).toContain('接着做')
  })

  it('正常回复不出现这句（不然每条都像出事了）', () => {
    render(makeMessage())
    expect(container.textContent ?? '').not.toContain('没写完')
  })

  it('被中断的那条内容照旧显示（只是多一句说明）', () => {
    render(makeMessage({ interrupted: true }))
    expect(container.textContent ?? '').toContain('先读 README')
  })
})
