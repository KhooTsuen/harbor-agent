import { describe, expect, it, beforeEach } from 'vitest'
import { handleNoticeEvent } from '../noticeEvents'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   提示类事件 → 一条 toast（不改消息、不挡人）

   这一组盯的是 2026-09-29 加的那一类：**内核说「这件事按你的设置没问，
   但你该知道」**。目前唯一的使用点是「完全访问」档下动了工作目录外的文件或
   敏感文件（`.env`）—— 不弹窗（用户明确选了「不给任何确认」），但要留个痕。

   为什么必须有它：把弹窗换成「什么都不说」就变成了**无声放行** ——
   那和用户要的「不问」是两件事：他要的是「别打断我」，不是「别告诉我」。
   ══════════════════════════════════════════════════════════════ */

beforeEach(() => {
  useUIStore.setState({ toasts: [] })
})

describe('提示类事件 / notice', () => {
  it('★ notice 事件弹一条 toast（标题与正文都用内核给的原文）', () => {
    handleNoticeEvent({
      type: 'notice',
      level: 'info',
      title: '访问了工作目录之外的文件',
      text: 'E:\\somewhere\\x.txt\n（当前是「完全访问」，按你的设置没有询问）',
    })

    const toasts = useUIStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.title).toBe('访问了工作目录之外的文件')
    expect(toasts[0]?.description).toContain('完全访问')
  })

  it('level=warning 时用 warning（不是一律 info）', () => {
    handleNoticeEvent({ type: 'notice', level: 'warning', title: '敏感文件', text: '.env' })
    expect(useUIStore.getState().toasts[0]?.kind).toBe('warning')
  })

  it('缺字段也不炸（内核改字段名时界面不该白屏）', () => {
    expect(() => handleNoticeEvent({ type: 'notice' })).not.toThrow()
    expect(useUIStore.getState().toasts).toHaveLength(1)
  })
})
