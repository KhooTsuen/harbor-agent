import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/stores/useAppStore'
import { folderIdFor } from '@/stores/app/folderIds'

/* ══════════════════════════════════════════════════════════════
   新建对话的**归属**：对话文件夹 vs 单独对话

   用户报的（2026-09-28）：在「对话文件夹」那一栏点「新建对话并指定目录」，
   选完目录新建出来的对话跑到了下半栏「单独对话」里。

   根因：那条路走的是 `createThread('', 目录)` —— 归属字段 projectId 原样用了
   传进来的空串。而侧栏是按**会话自己的 projectId** 分组的
   （`Sidebar.tsx`：`!t.projectId` 才进「单独对话」那一栏），所以它被摆错了地方。
   现在按**目录**推归属（`folderIdFor` 与内核 `dirIdFor` 逐字一致），
   并且目录还没登记过时补一个兜底分组 —— 不然那条会话哪一栏都不会出现。

   四条钉子：
     · 指定目录 → projectId = dir:<目录>，不进「单独对话」
     · 目录没登记 → 补兜底分组（名字取目录最后一段），会话能在那一栏里被找到
     · 已有登记项 → 用它，不再多建一个分组
     · 不指定目录（新建单独对话）→ 老行为不变，projectId 仍是空
   ══════════════════════════════════════════════════════════════ */

const looseRows = () => useAppStore.getState().threads.filter((t) => !t.projectId)

beforeEach(() => {
  useAppStore.getState().resetAll()
})

describe('新建对话 / 归属', () => {
  it('★ 指定目录 → 落在那个目录的文件夹里，不是「单独对话」', () => {
    const dir = 'E:\\proj\\demo'
    const id = useAppStore.getState().createThread('', dir)
    const thread = useAppStore.getState().threads.find((t) => t.id === id)

    expect(thread?.projectId).toBe(folderIdFor(dir))
    expect(thread?.workdir).toBe(dir)
    expect(looseRows().some((t) => t.id === id)).toBe(false)
  })

  it('★ 目录还没有登记项 → 补一个兜底分组，侧栏上半栏能找到它', () => {
    const dir = 'E:\\proj\\brand-new'
    const id = useAppStore.getState().createThread('', dir)
    const project = useAppStore.getState().projects.find((p) => p.id === folderIdFor(dir))

    expect(project).toBeTruthy()
    expect(project?.path).toBe(dir)
    expect(project?.name).toBe('brand-new')
    /* 侧栏上半栏就是「遍历 projects + 按 projectId 过滤」这两步 */
    const inFolder = useAppStore
      .getState()
      .threads.filter((t) => t.projectId === project?.id)
      .map((t) => t.id)
    expect(inFolder).toContain(id)
  })

  it('目录已有登记项 → 用登记的那个（不另外多建一个分组）', () => {
    const first = useAppStore.getState().projects[0]
    const before = useAppStore.getState().projects.length

    const id = useAppStore.getState().createThread('', first.path)
    expect(useAppStore.getState().threads.find((t) => t.id === id)?.projectId).toBe(first.id)
    expect(useAppStore.getState().projects.length).toBe(before)
  })

  it('给了目录就以目录为准（同时传了别的项目也不听那个）', () => {
    const other = useAppStore.getState().projects[1]
    const dir = 'E:\\proj\\win-by-dir'

    const id = useAppStore.getState().createThread(other.id, dir)
    expect(useAppStore.getState().threads.find((t) => t.id === id)?.projectId).toBe(
      folderIdFor(dir),
    )
  })

  it('不指定目录（新建单独对话）→ 老行为不变', () => {
    const id = useAppStore.getState().createThread('')
    expect(useAppStore.getState().threads.find((t) => t.id === id)?.projectId).toBe('')
    expect(looseRows().some((t) => t.id === id)).toBe(true)
  })

  it('文件夹里点「+」建对话 → 挂在该文件夹下（老路径不许坏）', () => {
    const first = useAppStore.getState().projects[0]
    const id = useAppStore.getState().createThread(first.id)
    const thread = useAppStore.getState().threads.find((t) => t.id === id)
    expect(thread?.projectId).toBe(first.id)
    expect(thread?.workdir).toBe(first.path)
  })
})

describe('把对话挂到目录 / setThreadWorkdir', () => {
  it('★ 挂到没登记过的目录 → 也补兜底分组（否则侧栏两栏都不显示它）', async () => {
    const id = useAppStore.getState().createThread('')
    const dir = 'E:\\proj\\moved'

    await useAppStore.getState().setThreadWorkdir(id, dir)

    const thread = useAppStore.getState().threads.find((t) => t.id === id)
    const project = useAppStore.getState().projects.find((p) => p.id === folderIdFor(dir))
    expect(thread?.projectId).toBe(folderIdFor(dir))
    expect(project?.name).toBe('moved')
    expect(looseRows().some((t) => t.id === id)).toBe(false)
  })

  it('摘掉文件夹（传空目录）→ 回到「单独对话」', async () => {
    const dir = 'E:\\proj\\demo'
    const id = useAppStore.getState().createThread('', dir)

    await useAppStore.getState().setThreadWorkdir(id, '')

    const thread = useAppStore.getState().threads.find((t) => t.id === id)
    expect(thread?.projectId).toBe('')
    expect(looseRows().some((t) => t.id === id)).toBe(true)
  })
})
