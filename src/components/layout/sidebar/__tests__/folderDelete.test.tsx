import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installDomStubs } from '@/components/chat/__tests__/domStubs'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { Sidebar } from '@/components/layout/Sidebar'
import { PermissionDialog } from '@/components/dialogs/PermissionDialog'

installDomStubs()

/* ══════════════════════════════════════════════════════════════
   删「对话文件夹」（2026-09-29 用户报：对话文件夹没有删除功能）

   真渲染一遍，四件事一起盯住：

   ① 菜单点得到 —— 以前文件夹表头只有一个「+」，**没有任何菜单**
   ② 确认框说真话 —— 删对话是**不可撤销**的，所以数字（几条）、
      后果（任务记录一起没了）、以及「磁盘上那个目录一个字节都不动」
      必须写在用户按下确认之前。这两句正好是「不许含糊」的那一类。
   ③ 确认之后真的干净 —— 对话没了、文件夹也没了。
      ⚠️ 这里最容易假通过：只调 `deleteProject` 的话，会话按 workdir 重新
      聚成一个**同名兜底分组**，文件夹当场复活（用户看到的就是「删不掉」）。
   ④ 别的文件夹、别的对话一个都不许动。

   ⚠️ 数字数的是**全部**（含已归档）：删除连归档的一起删，只数界面上
   看得见的那几条，确认框里的数字就会比实际删掉的少。
   ══════════════════════════════════════════════════════════════ */

const DIR_A = 'E:\\proj\\del-check-a'
const DIR_B = 'E:\\proj\\del-check-b'

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
  useUIStore.getState().closePermission()
  await act(async () => {
    root.render(
      <>
        <Sidebar />
        <PermissionDialog />
      </>,
    )
  })
})

/** 侧栏那一栏 */
const section = (label: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  if (!el) throw new Error(`没找到区块：${label}`)
  return el
}

/** 界面上按文字找可点的东西（菜单项在 portal 里，所以要查 document.body） */
function clickText(text: string): void {
  const hit = [...document.body.querySelectorAll<HTMLElement>('button,[role="menuitem"]')].find(
    (el) => el.textContent?.trim() === text,
  )
  if (!hit) throw new Error(`点不到「${text}」`)
  act(() => hit.click())
}

/**
 * 打开**指定目录**那个文件夹的菜单 → 点「删除文件夹」→ 弹确认框。
 *
 * ★ 不能直接取「第一个菜单按钮」：侧栏里本来就有别的文件夹（`resetAll()` 会带回
 *   示例数据），点到别人的菜单就会删错对象 —— 而断言数字时看起来又「很像对了」。
 */
function openDeleteConfirm(dir: string): void {
  /*
   * 取**最里面**那个同时含「目录路径」和「菜单按钮」的容器 —— 外层容器
   * （侧栏、那一栏的滚动区）也同时含这两样，所以必须取最后一个匹配的。
   */
  const rows = [...container.querySelectorAll<HTMLElement>('div')].filter(
    (el) =>
      el.querySelector('[aria-label="文件夹菜单"]') !== null &&
      (el.textContent ?? '').includes(dir),
  )
  const menu = rows.at(-1)?.querySelector<HTMLElement>('[aria-label="文件夹菜单"]')
  if (!menu) throw new Error(`没找到「${dir}」那一栏的菜单按钮`)
  act(() => menu.click())
  clickText('删除文件夹')
}

/** 建一个文件夹（目录）+ 里面 n 条对话，返回目录名 */
function seed(dir: string, titles: string[], archived = 0): void {
  act(() => {
    for (const title of titles) {
      const id = useAppStore.getState().createThread('', dir)
      useAppStore.getState().renameThread(id, title)
    }
    const all = useAppStore.getState().threads.filter((t) => t.workdir === dir)
    for (const thread of all.slice(0, archived)) {
      useAppStore.getState().toggleArchiveThread(thread.id)
    }
  })
}

describe('侧栏 / 删除对话文件夹', () => {
  it('★ 文件夹表头有菜单，点进去有「删除文件夹」', () => {
    seed(DIR_A, ['甲', '乙'])
    expect(container.querySelector('[aria-label="文件夹菜单"]')).not.toBeNull()

    openDeleteConfirm(DIR_A)
    expect(document.body.textContent).toContain('删除这个对话文件夹？')
  })

  it('★ 确认框说清后果：几条对话、不可撤销、磁盘上的文件不动', () => {
    seed(DIR_A, ['甲', '乙'])
    openDeleteConfirm(DIR_A)

    const text = document.body.textContent ?? ''
    expect(text).toContain('2 条对话')
    expect(text).toContain('不能撤销')
    /* 工作目录是用户的东西，删除只动应用自己的数据 —— 这句必须在 */
    expect(text).toContain('磁盘上那个目录里的文件一个都不动')
  })

  it('★ 确认之后：对话没了、文件夹也没了（不会以「兜底分组」复活）', async () => {
    seed(DIR_A, ['甲', '乙'])
    seed(DIR_B, ['丙'])
    const projectA = useAppStore.getState().projects.find((p) => p.path === DIR_A)
    expect(projectA).toBeTruthy()

    openDeleteConfirm(DIR_A)
    await act(async () => {
      clickText('删除')
    })

    const after = useAppStore.getState()
    expect(after.threads.filter((t) => t.workdir === DIR_A)).toHaveLength(0)
    expect(after.projects.find((p) => p.id === projectA?.id)).toBeUndefined()
    expect(section('对话文件夹').textContent).not.toContain('del-check-a')
    /* 另一个文件夹与它的对话一个不动 */
    expect(after.threads.filter((t) => t.workdir === DIR_B)).toHaveLength(1)
    expect(section('对话文件夹').textContent).toContain('del-check-b')
  })

  it('★ 已归档的也算进数字并一起删掉（不数它就会「删不干净」）', async () => {
    seed(DIR_A, ['甲', '乙', '丙'], 1)
    const archived = useAppStore.getState().threads.filter((t) => t.archived)
    expect(archived).toHaveLength(1)

    openDeleteConfirm(DIR_A)
    expect(document.body.textContent).toContain('3 条对话')

    await act(async () => {
      clickText('删除')
    })
    const after = useAppStore.getState()
    expect(after.threads.filter((t) => t.workdir === DIR_A)).toHaveLength(0)
    expect(after.projects.some((p) => p.path === DIR_A)).toBe(false)
  })

  it('取消就什么都不做（文件夹和对话都还在）', async () => {
    seed(DIR_A, ['甲'])
    openDeleteConfirm(DIR_A)
    await act(async () => {
      clickText('取消')
    })

    const after = useAppStore.getState()
    expect(after.threads.filter((t) => t.workdir === DIR_A)).toHaveLength(1)
    expect(after.projects.some((p) => p.path === DIR_A)).toBe(true)
  })
})
