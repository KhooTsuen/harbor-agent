import { beforeEach, describe, expect, it } from 'vitest'
import type { ClarifyQuestion } from '@/types'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { stopActiveRequest } from '../turnControl'

/* ══════════════════════════════════════════════════════════════
   澄清卡的两个「外部关闭」路径（2026-10-04，小尾巴 #4）

   `clarify.onCancel` 以前**只有测试调它** —— 生产里切对话/停任务都不会收卡：
     · 卡片状态只有一份，切走之后它跟着用户跑到别的对话里；
     · 不回话给内核，主进程会一直等到 5 分钟超时 → 被当成「用户离场」，
       按默认选项自己开工（可用户只是切了个对话 / 按了停止）。

   这里钉住两条路径，并且钉住「**只收这一条对话的**」—— 后台别的对话的卡不归它管。
   ══════════════════════════════════════════════════════════════ */

const questions: ClarifyQuestion[] = [
  {
    question: '用哪个？',
    options: [{ label: 'A', effect: '' }],
    allowFreeform: false,
    defaultValue: 'A',
    defaultFrom: 'model',
  },
]

let onCancel: () => void
let onCancelCalls = 0

function openClarify(threadId: string, confirmId = 'clr_x'): void {
  useUIStore.setState({
    clarify: {
      kind: 'clarify',
      confirmId,
      title: 't',
      description: '',
      confirmText: '',
      danger: false,
      threadId,
      clarify: questions,
      onCancel,
    },
  })
}

beforeEach(() => {
  onCancelCalls = 0
  onCancel = () => {
    onCancelCalls += 1
  }
  useUIStore.setState({ clarify: null })
  useAppStore.setState({ activeThreadId: 't1' })
})

describe('切对话 / 停任务时的澄清卡', () => {
  it('★ 切走：收卡 + 回话给内核（不是干等到超时）', () => {
    openClarify('t1')
    useAppStore.getState().setActiveThread('t2')
    expect(useUIStore.getState().clarify).toBeNull()
    expect(onCancelCalls).toBe(1)
  })

  it('★ 别的对话的卡不动（后台那条还在等用户）', () => {
    openClarify('t9')
    useAppStore.getState().setActiveThread('t2')
    expect(useUIStore.getState().clarify?.confirmId).toBe('clr_x')
    expect(onCancelCalls).toBe(0)
  })

  /*
   * ★ 「新建对话」也是一次离开 —— 但它**不走** setActiveThread，而是自己在
   *   createThread 里 set({ activeThreadId })。真机验证时正是这条路漏了：
   *   卡开着点「新建对话」，澄清卡跟到了新对话里。
   */
  it('★ 新建对话：也把上一张卡收掉（它不走 setActiveThread）', () => {
    openClarify('t1')
    useAppStore.getState().createThread()
    expect(useUIStore.getState().clarify).toBeNull()
    expect(onCancelCalls).toBe(1)
  })

  it('★ 新建对话时，卡属于**别的**对话 —— 不动它', () => {
    openClarify('t9')
    useAppStore.getState().createThread()
    expect(useUIStore.getState().clarify?.confirmId).toBe('clr_x')
    expect(onCancelCalls).toBe(0)
  })

  it('★ 停止这条对话：收卡 + 回话（否则内核当用户离场，按默认开工）', () => {
    openClarify('t1')
    stopActiveRequest('t1')
    expect(useUIStore.getState().clarify).toBeNull()
    expect(onCancelCalls).toBe(1)
  })

  it('停别的对话：这张卡留着', () => {
    openClarify('t1')
    stopActiveRequest('t2')
    expect(useUIStore.getState().clarify?.confirmId).toBe('clr_x')
    expect(onCancelCalls).toBe(0)
  })

  it('停止全部（不传 id）：这张卡也收', () => {
    openClarify('t1')
    stopActiveRequest()
    expect(useUIStore.getState().clarify).toBeNull()
    expect(onCancelCalls).toBe(1)
  })

  it('没有卡时两条路径都不炸', () => {
    useAppStore.getState().setActiveThread('t2')
    stopActiveRequest('t1')
    expect(onCancelCalls).toBe(0)
  })
})
