import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ErrorEntry, ErrorListResult } from '@/types/errors'

/* 把抓取换掉：store 只负责「拿到结果之后怎么算」，读盘那层不测 */
const { listErrors } = vi.hoisted(() => ({ listErrors: vi.fn() }))
vi.mock('@/lib/errorsApi', () => ({ listErrors }))

import { useErrorsStore } from '../useErrorsStore'

/* ══════════════════════════════════════════════════════════════
   Phase 1 · A1：错误信号 store

   钉住三条容易出错的规矩：
     · 首次抓取把「已读线」拉到当时 —— 历史错误不算「未读」（否则永远挂角标）
     · 之后的抓取只数 lastSeen 晚于已读线的严重错误
     · acknowledge() 只清「未读」，不清错误数据（打开面板 ≠ 已处理）
     · 读失败（ok:false）**不假装没有错误**，也不造新角标
   ══════════════════════════════════════════════════════════════ */

const entry = (over: Partial<ErrorEntry>): ErrorEntry => ({
  key: `k-${over.lastSeen ?? 0}-${over.severity ?? 'P0'}`,
  kind: 'tool_failure',
  severity: 'P0',
  message: 'm',
  hint: '',
  origin: 'tool',
  location: 'x',
  firstSeen: 0,
  lastSeen: 0,
  count: 1,
  needsUser: false,
  retryable: false,
  raw: '',
  context: { tool: '', taskId: '', sessionId: '' },
  ...over,
})

const ok = (entries: ErrorEntry[]): ErrorListResult => ({
  ok: true,
  dir: 'data/errors',
  entries,
  stats: { days: 7, unique: entries.length, total: entries.length },
})

const reset = (): void =>
  useErrorsStore.setState({
    snapshot: null,
    loading: false,
    ackAt: 0,
    unreadSevere: 0,
    worstUnread: null,
  })

describe('Phase 1 · A1 / 错误信号 store', () => {
  beforeEach(() => {
    listErrors.mockReset()
    reset()
  })

  it('★ 首次抓取：历史错误不算「未读」（否则一装上就永远挂角标）', async () => {
    listErrors.mockResolvedValueOnce(ok([entry({ severity: 'P0', lastSeen: 1 })]))
    await useErrorsStore.getState().refresh(7)
    const s = useErrorsStore.getState()
    expect(s.ackAt).toBeGreaterThan(0)
    expect(s.unreadSevere).toBe(0)
    expect(s.worstUnread).toBe(null)
  })

  it('★ 首次之后出现的严重错误 → 角标（并按最严重一级取色）', async () => {
    listErrors.mockResolvedValueOnce(ok([]))
    await useErrorsStore.getState().refresh(7)

    const future = Date.now() + 1000
    listErrors.mockResolvedValueOnce(
      ok([
        entry({ severity: 'P1', lastSeen: future }),
        entry({ severity: 'P0', lastSeen: future + 1 }),
      ]),
    )
    await useErrorsStore.getState().refresh(7)
    const s = useErrorsStore.getState()
    expect(s.unreadSevere).toBe(2)
    expect(s.worstUnread).toBe('P0')
  })

  it('★ acknowledge 只清「未读」，错误数据原样留着（打开面板 ≠ 已处理）', async () => {
    listErrors.mockResolvedValueOnce(ok([]))
    await useErrorsStore.getState().refresh(7)
    const future = Date.now() + 1000
    listErrors.mockResolvedValueOnce(ok([entry({ severity: 'P0', lastSeen: future })]))
    await useErrorsStore.getState().refresh(7)
    expect(useErrorsStore.getState().unreadSevere).toBe(1)

    useErrorsStore.getState().acknowledge()
    const s = useErrorsStore.getState()
    expect(s.unreadSevere).toBe(0)
    expect(s.worstUnread).toBe(null)
    /* 错误清单没有被抹掉 —— 仍然列着那一条 */
    expect(s.snapshot?.entries.length).toBe(1)
  })

  it('读失败（ok:false）不假装没有错误：角标保持、快照记下失败', async () => {
    listErrors.mockResolvedValueOnce(ok([]))
    await useErrorsStore.getState().refresh(7)
    const future = Date.now() + 1000
    listErrors.mockResolvedValueOnce(ok([entry({ severity: 'P0', lastSeen: future })]))
    await useErrorsStore.getState().refresh(7)
    expect(useErrorsStore.getState().unreadSevere).toBe(1)

    listErrors.mockResolvedValueOnce({
      ok: false,
      dir: '',
      entries: [],
      stats: {},
      reason: '读不出来',
    })
    await useErrorsStore.getState().refresh(7)
    const s = useErrorsStore.getState()
    expect(s.snapshot?.ok).toBe(false)
    /* 读失败不造新角标，也不清掉已有的 */
    expect(s.unreadSevere).toBe(1)
  })
})
