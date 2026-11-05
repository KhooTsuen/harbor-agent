import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * 撤销改动这整条流程（2026-11-06）
 *
 * 钉的是什么：内核判出冲突（`blocked: true`）之后，**界面这一层**有没有把话说清楚、
 * 有没有留下「仍然撤销」这个真出口。
 *
 * 为什么必须单独钉：内核自检（212 组）只证明「有冲突就拦下、force 才写盘」。
 * 但内核拦下之后如果界面只弹一句「撤销失败」，用户就以为坏了 —— 那条路同样是 bug。
 * 以前这类问题只有真机能发现（测试全绿 ≠ 能用），这里把它变成可重跑的。
 */

const rollbackMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/changesetApi', () => ({ changesetRollback: rollbackMock }))

const { requestRollback, fileName } = await import('@/components/chat/changesetRollbackFlow')

const CHANGESET = {
  id: 'cs_test_1',
  taskId: 'task_1',
  sessionId: 's1',
  title: '改标题',
  status: 'committed' as const,
  startedAt: 1,
  finishedAt: 2,
  fileCount: 2,
  files: ['E:\\proj\\TaskCenter.tsx', 'E:\\proj\\note.md'],
  supersededBy: '',
}

function deps() {
  return {
    setBusy: vi.fn(),
    showToast: vi.fn(),
    askPermission: vi.fn(),
    refresh: vi.fn(),
  }
}

beforeEach(() => {
  rollbackMock.mockReset()
})

describe('撤销改动 / 没有冲突（与改动前一致）', () => {
  it('直接撤、报个数、刷新列表，不弹任何卡', async () => {
    rollbackMock.mockResolvedValueOnce({
      ok: true,
      restored: ['E:\\proj\\a.ts'],
      removed: [],
      failed: [],
      blocked: false,
      conflicts: [],
    })
    const d = deps()
    const moved = await requestRollback(CHANGESET, d)

    expect(moved).toBe(true)
    expect(d.askPermission).not.toHaveBeenCalled()
    expect(d.showToast).toHaveBeenCalledWith('success', '已撤销这次改动', '恢复 1 个 · 删除 0 个')
    expect(d.refresh).toHaveBeenCalled()
  })

  it('部分文件没恢复成功 → 用 warning 报，不假装全好', async () => {
    rollbackMock.mockResolvedValueOnce({
      ok: true,
      restored: [],
      removed: [],
      failed: [{ path: 'x', reason: '文件太大，未快照' }],
      blocked: false,
      conflicts: [],
    })
    const d = deps()
    await requestRollback(CHANGESET, d)
    expect(d.showToast.mock.calls[0][0]).toBe('warning')
    expect(String(d.showToast.mock.calls[0][2])).toContain('1 个没恢复成功')
  })
})

describe('撤销改动 / 有覆盖冲突', () => {
  const blocked = () => ({
    ok: true,
    restored: [],
    removed: [],
    failed: [],
    blocked: true,
    conflicts: [
      {
        path: 'E:\\proj\\TaskCenter.tsx',
        kind: 'modified_after',
        reason: '这个文件在事务结束之后又被改过，撤销会覆盖掉那段改动',
        detail: '',
      },
      {
        path: 'E:\\proj\\note.md',
        kind: 'later_changeset',
        reason: '这个文件之后又被另一次改动（cs_abc123）改过',
        detail: 'cs_abc123',
      },
    ],
  })

  it('★ 不撤、先弹确认卡（盘上什么都没动）', async () => {
    rollbackMock.mockResolvedValueOnce(blocked())
    const d = deps()
    const moved = await requestRollback(CHANGESET, d)

    expect(moved).toBe(false)
    expect(d.showToast).not.toHaveBeenCalled()
    expect(d.refresh).not.toHaveBeenCalled()
    expect(d.askPermission).toHaveBeenCalledTimes(1)
  })

  it('★ 卡片说清「会丢什么」：标题带文件数、影响清单逐条列出原因', async () => {
    rollbackMock.mockResolvedValueOnce(blocked())
    const d = deps()
    await requestRollback(CHANGESET, d)

    const card = d.askPermission.mock.calls[0][0]
    expect(card.kind).toBe('rollback-changeset')
    expect(card.title).toContain('2 个文件又被改过')
    expect(card.impact).toEqual([
      'TaskCenter.tsx —— 这个文件在事务结束之后又被改过，撤销会覆盖掉那段改动',
      'note.md —— 这个文件之后又被另一次改动（cs_abc123）改过',
    ])
    /* 破坏性动作：要红按钮、要居中确认（`isCenteredConfirm` 只认 danger === true） */
    expect(card.danger).toBe(true)
    expect(card.confirmText).toBe('仍然撤销（覆盖）')
  })

  it('★ 点「仍然撤销」才真撤，而且带 force（不带 force 会被内核再拦一次）', async () => {
    rollbackMock.mockResolvedValueOnce(blocked()).mockResolvedValueOnce({
      ok: true,
      restored: ['E:\\proj\\TaskCenter.tsx'],
      removed: [],
      failed: [],
      blocked: false,
      conflicts: [],
    })
    const d = deps()
    await requestRollback(CHANGESET, d)
    d.askPermission.mock.calls[0][0].onConfirm()

    /* onConfirm 里是 `void forceRollback(...)`，等它跑完 */
    await vi.waitFor(() => expect(rollbackMock).toHaveBeenCalledTimes(2))
    expect(rollbackMock.mock.calls[1]).toEqual(['cs_test_1', { force: true }])
    await vi.waitFor(() => expect(d.refresh).toHaveBeenCalled())
  })

  it('强撤也失败时如实报错，不刷新（列表还是旧状态）', async () => {
    rollbackMock.mockResolvedValueOnce(blocked()).mockResolvedValueOnce({
      ok: false,
      restored: [],
      removed: [],
      failed: [],
      blocked: false,
      conflicts: [],
      error: '事务不存在',
    })
    const d = deps()
    await requestRollback(CHANGESET, d)
    d.askPermission.mock.calls[0][0].onConfirm()

    await vi.waitFor(() => expect(d.showToast).toHaveBeenCalled())
    expect(d.showToast).toHaveBeenCalledWith('error', '撤销失败', '事务不存在')
    expect(d.refresh).not.toHaveBeenCalled()
  })
})

describe('撤销改动 / 明细', () => {
  it('转圈状态一定会收（失败也不留一个永远转的按钮）', async () => {
    rollbackMock.mockRejectedValueOnce(new Error('桥断了'))
    const d = deps()
    await expect(requestRollback(CHANGESET, d)).rejects.toThrow('桥断了')
    expect(d.setBusy).toHaveBeenCalledWith('cs_test_1')
    expect(d.setBusy).toHaveBeenCalledWith('')
  })

  it('冲突清单只显示文件名（全路径会把原因挤没）', () => {
    expect(fileName('E:\\CodexWorkbench\\src\\components\\chat\\TaskCenter.tsx')).toBe(
      'TaskCenter.tsx',
    )
    expect(fileName('/home/u/proj/note.md')).toBe('note.md')
  })
})
