import { beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   AG-036 后半：改动 diff 跟着任务快照一起刷

   右栏「审查」与顶栏那个 +N −M 读的都是 `useTaskStore.diff`。这里验两件事：
     · refresh 真的去拉 diff（不是只刷新了任务列表）
     · **按当前对话拉**（别的对话的改动不该出现在这条对话的审查里）
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({ asked: [] as string[] }))

vi.mock('@/lib/safetyApi', () => ({
  taskList: async () => [],
  taskRecovery: async () => [],
  changesetList: async () => [],
  changesetDiff: async (sessionId: string) => {
    h.asked.push(sessionId)
    return {
      id: 'cs_1',
      title: '改 README',
      taskId: 'task_1',
      sessionId,
      status: 'committed',
      at: 1,
      files: [
        {
          path: 'E:/demo/README.md',
          additions: 1,
          deletions: 1,
          hunks: [{ header: '@@ -1,1 +1,1 @@', lines: [{ type: 'add' as const, content: 'x' }] }],
        },
      ],
      additions: 1,
      deletions: 1,
      skipped: [],
    }
  },
}))

import { useAppStore } from '@/stores/useAppStore'
import { useTaskStore } from '@/stores/useTaskStore'

beforeEach(() => {
  h.asked = []
  useAppStore.getState().resetAll()
  useTaskStore.setState({ diff: null, tasks: [], changesets: [], unfinished: [] })
})

describe('AG-036b / 未提交的改动跟着快照刷', () => {
  it('★ refresh 会去拉 diff', async () => {
    await useTaskStore.getState().refresh()
    const diff = useTaskStore.getState().diff
    expect(diff?.files).toHaveLength(1)
    expect(diff?.files[0]?.additions).toBe(1)
    expect(diff?.title).toBe('改 README')
  })

  it('★ 按当前对话拉（审查标签是这条对话的，不是全局的）', async () => {
    const active = useAppStore.getState().activeThreadId
    await useTaskStore.getState().refresh()
    expect(h.asked.at(-1)).toBe(active)

    const other = useAppStore.getState().createThread()
    await useTaskStore.getState().refresh()
    expect(h.asked.at(-1)).toBe(other)
    expect(h.asked.at(-1)).not.toBe(active)
  })

  it('拿不到 diff 时留空对象也照样刷新（界面显示「还没有改动」）', async () => {
    await useTaskStore.getState().refresh()
    expect(useTaskStore.getState().loaded).toBe(true)
    expect(useTaskStore.getState().diff).not.toBeNull()
  })
})
