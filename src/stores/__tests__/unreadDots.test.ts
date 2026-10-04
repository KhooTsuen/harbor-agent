import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   对话行的提醒点（真机反馈 4）

   用户的问题：同时跑好几条对话，跑完的那条没有任何提醒 —— 得自己挨个点开找。
   规矩：内存态、只从状态语言表取色、慢速闪烁、点开即清、仍在跑则转运行态。
   ══════════════════════════════════════════════════════════════ */

const read = (file: string): string => readFileSync(join(process.cwd(), file), 'utf8')

describe('提醒点：状态机', () => {
  beforeEach(() => {
    useUIStore.setState({ unread: {} })
  })

  it('★ 点亮之后点开那条对话就清掉（别的对话的点不受影响）', () => {
    useUIStore.getState().markUnread('t1', 'completed')
    useUIStore.getState().markUnread('t2', 'failed')
    expect(useUIStore.getState().unread).toEqual({ t1: 'completed', t2: 'failed' })

    useAppStore.getState().setActiveThread('t1')
    expect(useUIStore.getState().unread.t1).toBeUndefined()
    expect(useUIStore.getState().unread.t2).toBe('failed')
  })

  it('没点亮过的对话不会凭空多出一个点', () => {
    useAppStore.getState().setActiveThread('t3')
    expect(useUIStore.getState().unread).toEqual({})
  })
})

describe('提醒点：接线', () => {
  it('流式事件在「跑完 / 失败 / 等你确认」时点亮，且只点**不是当前在看的那条**', () => {
    const arm = read('src/stores/thread/unreadArm.ts')
    expect(arm).toContain("'completed'")
    expect(arm).toContain("'failed'")
    expect(arm).toContain("'waiting_user'")
    expect(arm).toContain('markUnread(threadId, phase)')
    expect(arm).toContain('activeThreadId === threadId')
    /* 接线还得在：流式事件里必须真的调它，否则上面的规矩形同虚设 */
    expect(read('src/stores/thread/streamEvents.ts')).toContain('armUnread(state.threadId, phase)')
  })

  it('行上看的是 phase，不是旧的 status（AG-001）', () => {
    const dot = read('src/components/layout/sidebar/UnreadDot.tsx')
    expect(dot).toContain('isActivePhase(thread.phase)')
    expect(dot).not.toContain('thread.status')
  })

  it('颜色只从状态语言表取，组件里不写死色值', () => {
    const dot = read('src/components/layout/sidebar/UnreadDot.tsx')
    expect(dot).toContain('colorOf(status)')
    expect(dot).not.toMatch(/bg-\[var\(--/)
  })

  it('闪烁是慢速的（2.5–3s），不是默认那条 1.6s', () => {
    expect(read('tailwind.config.js')).toContain("'pulse-slow': 'pulse 2.6s")
    expect(read('src/components/layout/sidebar/UnreadDot.tsx')).toContain('animate-pulse-slow')
  })
})
