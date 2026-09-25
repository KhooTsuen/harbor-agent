import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageItem } from '../MessageItem'
import { runMockTurn } from '@/stores/thread/mockTurn'

/*
 * 「重跑」在测试环境里走的是 mock turn（没有真后端）。
 * 直接盯这个接缝：**用它被调用时的参数**证明"切到哪一版就按哪一版重跑"。
 * 比"多了一条助手消息"精确 —— 后者取决于 mock 的实现细节。
 */
vi.mock('@/stores/thread/mockTurn', () => ({
  runMockTurn: vi.fn(async () => {}),
}))
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import type { Message } from '@/types'

/* ══════════════════════════════════════════════════════════════
   编辑一条用户消息 / 同一条消息的多个版本

   用户报过两件事，这里都钉住：

   ① 「编辑貌似只是个占位按钮」—— 根因是它走 **`window.prompt`**，
      Electron 里没有 prompt()，静默返回 null，点了等于没点。
   ② 「编辑好之后会有两个同样的提问过程」—— 根因是编辑后调了 `sendMessage`，
      而 `sendMessage` 一定会**新增一条用户消息**，于是同一条提问出现两次。
      现在改成：内容改在同一条消息上（多一个版本），然后**用现有历史重跑**。

   为什么真渲染而不是源码守卫：这个项目反复踩过「断言到注释里的字」的坑。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

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

function seed(messages: Message[]): void {
  useAppStore.setState({
    activeThreadId: 't1',
    threads: [{ id: 't1', title: '测试', messages, workdir: '' }],
  } as never)
}

function render(message: Message): void {
  act(() => {
    root.render(<MessageItem message={message} />)
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

const messages = () => useAppStore.getState().threads[0].messages

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useUIStore.setState({ toasts: [] })
  seed([userMessage()])
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

  it('★ 真的出现一个带原文的编辑框', () => {
    render(userMessage())
    act(() => button('编辑')?.click())
    const area = container.querySelector('textarea')
    expect(area?.value).toBe('把 README 的安装步骤改一下')
    expect(area?.getAttribute('aria-label')).toBe('编辑这条消息')
  })

  it('按 Esc 取消（不用去够按钮）', () => {
    render(userMessage())
    act(() => button('编辑')?.click())
    const area = container.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('textarea')).toBeFalsy()
    expect(messages()[0].content).toBe('把 README 的安装步骤改一下')
  })
})

describe('保存（改内容 + 按新内容重新回答）', () => {
  it('★ 只有一条用户消息 —— 不会再出现「两个同样的提问」', () => {
    render(userMessage())
    act(() => button('编辑')?.click())
    type('把 README 的安装步骤改成一行的')
    act(() => button('保存')?.click())

    const list = messages()
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('把 README 的安装步骤改成一行的')
    expect(list.filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('★ 改成了同一条消息的第 2 版（可以切回去）', () => {
    render(userMessage())
    act(() => button('编辑')?.click())
    type('把 README 的安装步骤改成一行的')
    act(() => button('保存')?.click())

    const saved = messages()[0]
    expect(saved.versions).toEqual(['把 README 的安装步骤改一下', '把 README 的安装步骤改成一行的'])
    expect(saved.versionIndex).toBe(1)
    expect(saved.edited).toBe(true)
  })

  it('★ 保存要落盘（只改内存的话，重启后编辑就没了）', () => {
    const written: Array<Record<string, unknown>> = []
    useAppStore.setState({
      persistMessage: (_id: string, m: never) => {
        written.push(m as unknown as Record<string, unknown>)
      },
    } as never)
    render(userMessage())
    act(() => button('编辑')?.click())
    type('改过之后的问题')
    act(() => button('保存')?.click())

    const user = written.find((m) => m.role === 'user')
    expect(user, '保存时没有把用户消息写下去').toBeTruthy()
    /* 带 key 才会在读的时候按 key 收敛成一条，而不是又冒出一条 */
    expect(user?.key).toBe('u1')
    expect(user?.content).toBe('改过之后的问题')
    expect(user?.versions).toEqual(['把 README 的安装步骤改一下', '改过之后的问题'])
  })

  it('空白内容不许保存（按钮禁用）', () => {
    render(userMessage())
    act(() => button('编辑')?.click())
    type('   ')
    expect(button('保存')?.disabled).toBe(true)
  })
})

describe('版本切换 ‹ n / N ›', () => {
  const twoVersion = (): Message =>
    userMessage({
      content: '第二版的问题',
      versions: ['第一版的问题', '第二版的问题'],
      versionIndex: 1,
      edited: true,
    })

  it('只有一版时不显示切换（没什么可切的）', () => {
    render(userMessage())
    expect(container.querySelector('[data-message-versions="true"]')).toBeFalsy()
  })

  it('★ 多版时常显「2 / 2」，并且它不在悬停操作条里', () => {
    render(twoVersion())
    const nav = container.querySelector('[data-message-versions="true"]')
    expect(nav?.textContent?.replace(/\s/g, '')).toBe('2/2')
    /* 常显 = 没被 opacity-0 那一层包住 */
    expect(nav?.closest('.opacity-0')).toBeNull()
  })

  it('★ 点「上一版」切回第一版', () => {
    seed([twoVersion()])
    render(messages()[0])
    act(() => {
      ;(container.querySelector('button[aria-label="上一版"]') as HTMLButtonElement)?.click()
    })
    const now = messages()[0]
    expect(now.content).toBe('第一版的问题')
    expect(now.versionIndex).toBe(0)
    /* 真实链路里消息列表是从 store 重渲染的 —— 这里也照着做一次，再看界面 */
    render(messages()[0])
    expect(
      container.querySelector('[data-message-versions="true"]')?.textContent?.replace(/\s/g, ''),
    ).toBe('1/2')
  })

  it('已在第一版时「上一版」禁用，最后一版时「下一版」禁用', () => {
    seed([userMessage({ content: 'a', versions: ['a', 'b'], versionIndex: 0 })])
    render(messages()[0])
    expect(
      (container.querySelector('button[aria-label="上一版"]') as HTMLButtonElement)?.disabled,
    ).toBe(true)
    expect(
      (container.querySelector('button[aria-label="下一版"]') as HTMLButtonElement)?.disabled,
    ).toBe(false)
  })
})

describe('编辑框的宽度', () => {
  it('★ 宽度上限必须和下方输入框用同一个变量（用户要求：跟随对话框宽度）', () => {
    /*
     * jsdom 不做排版，宽度量不出来 —— 所以这里钉的是**关系**：
     * 编辑框的上限和 Composer 的上限必须是同一个 CSS 变量。
     * 谁哪天把它写死成 px 或者换成另一个值，这条会红。
     */
    const composer = readFileSync(join(__dirname, '..', 'Composer.tsx'), 'utf8').match(
      /<div[^>]*data-composer-shell[^>]*>/,
    )
    const token = composer?.[0].match(/max-w-\[var\((--[a-z-]+)\)\]/)?.[1]
    expect(token, '在 Composer 里没找到宽度上限变量').toBeTruthy()

    render(userMessage())
    act(() => button('编辑')?.click())
    const root = container.querySelector('[data-message-editor="true"]')
    /*
     * ★ 下面这行**必须拼字符串**，不能写成模板字面量。
     *
     * Tailwind 会扫 src 下所有 ts/tsx（**连注释和测试一起扫**），把看着像类名的字面量
     * 抽出来生成 CSS。模板里那个插值会被原样当成 CSS 值，而 lightningcss 解不了，
     * 整个 vite build 直接报错（Unexpected token Delim）—— 后果很阴：
     * 构建失败 → 应用还跑着旧代码 → 你以为改动没生效。
     * 所以这句话本身也不能出现（它刚把我坑过第二次）。
     */
    const expected = ['max-w-[var(', token, ')]'].join('')
    expect(root?.className ?? '').toContain(expected)
  })

  it('★ 编辑时外层要撑满（不然百分比会被当成 auto，编辑框缩成一条）', () => {
    render(userMessage())
    act(() => button('编辑')?.click())
    const outer = container.querySelector('[data-message-editor="true"]')?.parentElement
    expect(outer?.className ?? '').toContain('w-full')
  })
})

it('★ 切版本只换显示；点「补一版回答」才真的重答那一版', () => {
  seed([
    userMessage({
      content: '第二版的问题',
      versions: ['第一版的问题', '第二版的问题'],
      versionIndex: 1,
      edited: true,
    }),
  ])
  render(messages()[0])
  act(() => {
    ;(container.querySelector('button[aria-label="上一版"]') as HTMLButtonElement)?.click()
  })
  /* ★ 只换文字，不跑（以前这里直接重跑 —— 用户报的「切个版本又自己输出一轮」） */
  expect(runMockTurn).not.toHaveBeenCalled()
  expect(messages()[0].content).toBe('第一版的问题')
  /* 没回答过这一版 → 弹提示；用户点了才真跑，而且用的是**那一版**的文字 */
  const toast = useUIStore.getState().toasts[0]
  expect(toast?.title).toBe('这一版还没有回答过')
  act(() => {
    toast?.action?.onClick()
  })
  expect(runMockTurn).toHaveBeenCalledWith('t1', '第一版的问题', expect.any(Function))
})
