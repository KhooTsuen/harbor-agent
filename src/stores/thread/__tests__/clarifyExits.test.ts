import { beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   澄清卡的两个「退出口」真的接上了哪条链路（AG-053 批⑤）

   用户对「先不做了」的要求原话是：**任务暂停，可恢复**。它由两件事拼成：
     · `chat:confirm` 回一个带 `cancelled` 的标记（模型据此停手、写交接）
     · `chat:pause`   把这轮停在**下一个安全点**（台账变 paused，任务列表能「继续」）

   为什么这里要单独钉：本项目真出过「留个空函数占位，tsc/lint/测试全绿，
   功能整个没了」（见 `docs/踩坑记录.md`）。两个调用都写在同一个闭包里，
   删掉任何一行都不会让别的测试变红 —— 除非这里盯住参数本身。

   ⚠️ 只测「接线与参数」，不测 React 渲染：卡片那侧在
      `components/chat/__tests__/clarifyCard.test.tsx`。
   ══════════════════════════════════════════════════════════════ */

/*
 * `vi.mock` 的工厂会被**提升**到文件顶部，所以里面引用不到下面的 `const` ——
 * 必须用 `vi.hoisted` 一起提上去（vitest 5 的行为，直接在工厂里引用顶层变量会报
 * 「Cannot access 'xxx' before initialization」）。
 *
 * 参数类型写全是为了下面能直接断言实参（`mock.calls[0][1]`）——
 * 不写的话推断出来是空参数表，`calls[0]?.[1]` 会变成 `any`/报错。
 */
const { confirmChat, pauseChat, taskUpdate } = vi.hoisted(() => ({
  confirmChat: vi.fn(async (_id: string, _approved: boolean, _answer?: string) => ({ ok: true })),
  pauseChat: vi.fn(async (_requestId: string) => {}),
  taskUpdate: vi.fn(async (_id: string, _patch: Record<string, unknown>) => {}),
}))

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return { ...actual, confirmChat, useRealBackend: false }
})

vi.mock('@/lib/chatControl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chatControl')>()
  return { ...actual, pauseChat }
})

vi.mock('@/lib/safetyApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/safetyApi')>()
  return { ...actual, taskUpdate }
})

import { applyPauseAfterTurn, askPermissionFor } from '../confirmEvents'
import { useUIStore } from '@/stores/useUIStore'
import type { ClarifyReply } from '@/types'

/** 内核推过来的那条澄清事件（形状照 `handlers/chat-confirm.cjs` 的 payload） */
function askClarify(): void {
  askPermissionFor({
    type: 'confirm_request',
    kind: 'clarify',
    confirmId: 'clr_1',
    /* ★ 这是**对话这一轮**的 requestId（chat-emit 补的），pause 要的正是它 */
    requestId: 'req_7',
    sessionId: 'sess_1',
    /* ★ 任务 id：这一轮收尾后要把「这条任务」标成 paused（少了它就标不上） */
    taskId: 'task_9',
    questions: [
      {
        question: '用哪个包管理器？',
        options: [{ label: 'pnpm', effect: '仓库里有 pnpm-lock.yaml，换 npm 会多装 1 份依赖' }],
        allowFreeform: true,
        defaultValue: 'pnpm',
        defaultFrom: 'model',
      },
    ],
  })
}

/** 拿界面当前挂着的那张卡，按下它的回话回调（等于用户点了） */
function reply(replyValue: ClarifyReply): void {
  const card = useUIStore.getState().clarify
  expect(card?.confirmId).toBe('clr_1')
  card?.onClarify?.(replyValue)
}

beforeEach(() => {
  confirmChat.mockClear()
  pauseChat.mockClear()
  taskUpdate.mockClear()
  useUIStore.getState().closeClarify()
})

describe('澄清卡：点「先不做了」之后到底发生了什么', () => {
  it('★ 同一轮里既回话、又把这轮停在安全点（暂停链路 = 可恢复的前提）', () => {
    askClarify()
    reply({ skipped: true, answers: [], cancelled: true })

    expect(confirmChat).toHaveBeenCalledTimes(1)
    const [id, approved, wire] = confirmChat.mock.calls[0] ?? []
    expect(id).toBe('clr_1')
    /* 两个出口都是「不批」（内核那条通道传的是布尔） */
    expect(approved).toBe(false)
    expect(String(wire)).toContain('"cancelled":true')

    /* ★ 暂停用的是**对话的 requestId**，不是 confirmId —— 传错就是静默不暂停 */
    expect(pauseChat).toHaveBeenCalledWith('req_7')
  })

  it('★「换个说法」只回话，不暂停（他还要继续做，只是让模型重问）', () => {
    askClarify()
    reply({ skipped: true, answers: [], rephrase: true })

    expect(String(confirmChat.mock.calls[0]?.[2])).toContain('"rephrase":true')
    expect(pauseChat).not.toHaveBeenCalled()
  })

  it('正常答复：照旧把答案送出去，不带退出口标记、也不暂停', () => {
    askClarify()
    reply({
      skipped: false,
      answers: [{ question: '用哪个包管理器？', choice: 'pnpm', text: '' }],
    })

    const [, approved, wire] = confirmChat.mock.calls[0] ?? []
    expect(approved).toBe(true)
    expect(String(wire)).toContain('"choice":"pnpm"')
    expect(String(wire)).not.toContain('cancelled')
    expect(pauseChat).not.toHaveBeenCalled()
  })

  it('卡片被外部关掉仍只当跳过：**绝不**顺手暂停（那条路没点过任何按钮）', () => {
    askClarify()
    /* 外部关闭走的是 `onCancel`（不是 onClarify）——
       今天只有权限那条路会真的触发它，但契约在这儿：回话不带任何标记 */
    useUIStore.getState().clarify?.onCancel?.()

    expect(confirmChat).toHaveBeenCalledTimes(1)
    expect(confirmChat.mock.calls[0]?.[1]).toBe(false)
    expect(String(confirmChat.mock.calls[0]?.[2] ?? '')).not.toContain('cancelled')
    expect(pauseChat).not.toHaveBeenCalled()
  })
})

/*
 * 「任务标成 paused」这一段绕了一圈（批⑤ 真机第一遍就是这里红的），所以单独钉：
 *   点「先不做了」**不能**当场写台账 —— 那一轮收尾时主进程自己要写一次 completed，
 *   而那次写比渲染层收到的 done 事件早，当场写会被盖掉（用户看到「已完成」）。
 *   所以意图要等到 done 再落 —— 由 `applyPauseAfterTurn`（streamEvents 的 done 分支调）。
 */
describe('先不做了：台账上的 paused 是「等这一轮收尾」才写的', () => {
  it('★ 点的那一刻不写台账（写了也会被主进程的收尾写盖掉）', () => {
    askClarify()
    reply({ skipped: true, answers: [], cancelled: true })
    expect(taskUpdate).not.toHaveBeenCalled()
  })

  it('★ 这一轮 done 了 → 把这条任务标成 paused（可恢复的状态）', () => {
    askClarify()
    reply({ skipped: true, answers: [], cancelled: true })
    applyPauseAfterTurn('req_7')

    expect(taskUpdate).toHaveBeenCalledTimes(1)
    const [id, patch] = taskUpdate.mock.calls[0] ?? []
    expect(id).toBe('task_9')
    expect(patch?.status).toBe('paused')
    expect(Number(patch?.pausedAt)).toBeGreaterThan(0)
    expect(patch?.pauseReason).toBe('user')
  })

  it('★ 只认自己那一条：别的 requestId 的 done 不会把任务停掉', () => {
    askClarify()
    reply({ skipped: true, answers: [], cancelled: true })
    applyPauseAfterTurn('req_别的')
    expect(taskUpdate).not.toHaveBeenCalled()
  })

  it('★ 只写一次（done 重复到达不会反复改台账）', () => {
    askClarify()
    reply({ skipped: true, answers: [], cancelled: true })
    applyPauseAfterTurn('req_7')
    applyPauseAfterTurn('req_7')
    expect(taskUpdate).toHaveBeenCalledTimes(1)
  })

  it('★「换个说法」绝不能把任务停掉（他还想接着做）', () => {
    askClarify()
    reply({ skipped: true, answers: [], rephrase: true })
    applyPauseAfterTurn('req_7')
    expect(taskUpdate).not.toHaveBeenCalled()
    expect(pauseChat).not.toHaveBeenCalled()
  })
})
