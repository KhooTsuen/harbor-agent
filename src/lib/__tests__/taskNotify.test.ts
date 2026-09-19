import { describe, expect, it } from 'vitest'
import { shouldNotifyEnd } from '../taskNotify'

/* AG-029：「该不该打扰用户」的纯函数部分（通知内容在核心里，见内核第 32 组） */

describe('AG-029 / 该不该打扰（不抢焦点）', () => {
  it('正在看这条对话 + 窗口在前台 → 不打扰', () => {
    expect(shouldNotifyEnd({ threadId: 'a', activeThreadId: 'a', windowFocused: true })).toBe(false)
  })

  it('别的对话结束了 → 提示', () => {
    expect(shouldNotifyEnd({ threadId: 'b', activeThreadId: 'a', windowFocused: true })).toBe(true)
  })

  it('★ 窗口在后台（用户切到别的应用了）→ 哪怕是当前对话也提示', () => {
    expect(shouldNotifyEnd({ threadId: 'a', activeThreadId: 'a', windowFocused: false })).toBe(true)
  })

  it('没有活动对话时也算「没在看」', () => {
    expect(shouldNotifyEnd({ threadId: 'a', activeThreadId: '', windowFocused: true })).toBe(true)
  })
})
