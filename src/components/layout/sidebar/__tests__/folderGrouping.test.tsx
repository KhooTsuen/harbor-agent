import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installDomStubs } from '@/components/chat/__tests__/domStubs'
import { useAppStore } from '@/stores/useAppStore'
import { Sidebar } from '@/components/layout/Sidebar'

installDomStubs()

/* ══════════════════════════════════════════════════════════════
   侧栏**实际渲染**出来的归属（用户报的那个现象，端到端盯一遍）

   用户：「对话文件夹选择文件夹后应该是在对话文件夹显示，不应该在单独会话显示」

   这条比 store 单测多走一步：真把 `Sidebar` 渲染出来，看那条新对话**落在哪个
   `[aria-label]` 区块里** —— 侧栏的分组就是 `Sidebar.tsx` 里那两行
   （上半按 `projects` 遍历 + `t.projectId === project.id`；下半 `!t.projectId`）。
   改前跑这条：新对话会出现在「单独对话」里 → 红。

   原生「选择文件夹」对话框脚本驱动不了，所以这里直接走 store 的同一条路
   （`createThread('', 目录)`），真机部分靠人工点一次。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterAll(() => {
  act(() => root.unmount())
  container.remove()
})

beforeEach(async () => {
  useAppStore.getState().resetAll()
  await act(async () => {
    root.render(<Sidebar />)
  })
})

const section = (label: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  if (!el) throw new Error(`没找到区块：${label}`)
  return el
}

describe('侧栏渲染 / 新对话落在哪一栏', () => {
  it('★ 指定目录新建的对话出现在「对话文件夹」里，不在「单独对话」里', async () => {
    const dir = 'E:\\proj\\ui-check'
    await act(async () => {
      const id = useAppStore.getState().createThread('', dir)
      useAppStore.getState().renameThread(id, '归属检查专用标题')
      root.render(<Sidebar />)
    })

    expect(section('对话文件夹').textContent).toContain('归属检查专用标题')
    /* 分组名取目录最后一段（folderIdFor → fallbackProjectFor 的命名规则） */
    expect(section('对话文件夹').textContent).toContain('ui-check')
    /* ★ 文件夹表头要能看出是哪个目录（用户报「两个文件夹看不出区别」） */
    expect(section('对话文件夹').textContent).toContain('E:\\proj\\ui-check')
    expect(section('单独对话').textContent).not.toContain('归属检查专用标题')
  })

  it('新建单独对话（不给目录）仍然落在「单独对话」里', async () => {
    await act(async () => {
      const id = useAppStore.getState().createThread('')
      useAppStore.getState().renameThread(id, '单独对话专用标题')
      root.render(<Sidebar />)
    })

    expect(section('单独对话').textContent).toContain('单独对话专用标题')
    expect(section('对话文件夹').textContent).not.toContain('单独对话专用标题')
  })
})
