import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { pickAboveInput } from '@/lib/clarify'
import { stopActiveRequest, endTurnRequest } from '../turnControl'
import { onCardTimeout, clearPermissionForThread } from '../confirmEvents'

/* ══════════════════════════════════════════════════════════════
   僵尸权限卡（2026-10-07 真机复现）

   用户报的：「AI 发提问卡我这边收不到，一直显示正在进行中」。

   根因：模拟器输入框上方的卡是**两个独立槽位**（permission / clarify），由
   `pickAboveInput` 仲裁 —— **权限优先**。而权限卡以前**只在用户点「取消/允许」
   时才消失**；主进程超时按拒绝继续 / 用户停任务 / 切对话 / 轮末结算，这几条路
   都不清它。卡就烂在槽里，把后面**所有澄清卡全挡住**：用户看不到提问卡，
   主进程干等到 5 分钟超时，界面一直「正在进行中」。

   真机证据：让 Agent 跑命令 → 权限卡 → 点「停止」→ 权限卡仍在（主进程日志
   「轮末结算 1 条」）→ 再让 Agent `ask_user` → 澄清卡容器 hidden、不可见 →
   点掉僵尸卡 → 澄清卡立刻可见。截图 `shots/card-bug/zombie-blocks-clarify.png`。

   这一组钉住「作废的权限卡必须被收掉」，而且**只收属于那条对话的**。
   ══════════════════════════════════════════════════════════════ */

let onCancelCalls = 0
let onCancel: () => void

function openPermission(threadId: string, confirmId = 'cfm_x'): void {
  useUIStore.setState({
    permission: {
      kind: 'run-command',
      confirmId,
      title: 't',
      description: '',
      confirmText: '',
      danger: false,
      threadId,
      onCancel,
    },
  })
}

beforeEach(() => {
  onCancelCalls = 0
  onCancel = () => {
    onCancelCalls += 1
  }
  useUIStore.setState({ permission: null, clarify: null })
  useAppStore.setState({ activeThreadId: 't1' })
})

describe('僵尸权限卡：作废后必须收掉，否则挡住后面所有澄清卡', () => {
  it('★ 因果链：permission 在场时，澄清卡永远显示不出来', () => {
    expect(pickAboveInput({ permission: true, clarify: true })).toBe('permission')
    expect(pickAboveInput({ permission: false, clarify: true })).toBe('clarify')
  })

  it('★ 停任务：收卡 + 回话拒绝（别让主进程干等到超时）', () => {
    openPermission('t1')
    stopActiveRequest('t1')
    expect(useUIStore.getState().permission).toBeNull()
    expect(onCancelCalls).toBe(1)
  })

  it('★ 切走对话：收卡 + 回话拒绝', () => {
    openPermission('t1')
    useAppStore.getState().setActiveThread('t2')
    expect(useUIStore.getState().permission).toBeNull()
    expect(onCancelCalls).toBe(1)
  })

  it('别的对话的权限卡不动（后台那条还在等用户）', () => {
    openPermission('t9')
    stopActiveRequest('t1')
    useAppStore.getState().setActiveThread('t2')
    expect(useUIStore.getState().permission?.confirmId).toBe('cfm_x')
    expect(onCancelCalls).toBe(0)
  })

  it('★ 一轮结束（endTurnRequest）：清本对话的卡，但**不回话**（主进程已结算）', () => {
    openPermission('t1')
    endTurnRequest('t1')
    expect(useUIStore.getState().permission).toBeNull()
    expect(onCancelCalls).toBe(0)
  })

  it('★ 一轮结束：别的对话还在等的卡不动', () => {
    openPermission('t9')
    endTurnRequest('t1')
    expect(useUIStore.getState().permission?.confirmId).toBe('cfm_x')
  })

  it('★ confirm.timeout：按 confirmId 精确收（已经换成下一张就不误关）', () => {
    openPermission('t1', 'cfm_old')
    onCardTimeout({ type: 'confirm.timeout', confirmId: 'cfm_other' })
    expect(useUIStore.getState().permission?.confirmId).toBe('cfm_old')
    onCardTimeout({ type: 'confirm.timeout', confirmId: 'cfm_old' })
    expect(useUIStore.getState().permission).toBeNull()
    expect(onCancelCalls).toBe(0)
  })

  it('clearPermissionForThread：只清指定对话', () => {
    openPermission('t1')
    clearPermissionForThread('t2')
    expect(useUIStore.getState().permission?.confirmId).toBe('cfm_x')
    clearPermissionForThread('t1')
    expect(useUIStore.getState().permission).toBeNull()
  })

  it('没有卡时各条路径都不炸', () => {
    stopActiveRequest('t1')
    endTurnRequest('t1')
    onCardTimeout({ type: 'confirm.timeout', confirmId: 'x' })
    expect(onCancelCalls).toBe(0)
  })
})
