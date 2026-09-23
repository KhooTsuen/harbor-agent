/* ══════════════════════════════════════════════════════════════
   对话流事件（主进程 → 渲染层）

   从 `models.ts` 拆出来的：那边 315 行贴了上限，而这一整块本来就是**一个完整的东西**
   —— 一次对话从开始到结束推给界面的所有事件。按职责切，不是按行数切：
   事件的形状归这里，配置与模型信息留在 `models.ts`。

   ⚠️ `models.ts` 里有一行 `export type { ChatEvent } from './chat-events'`，
   所以老路径 `@/types/models` 的 import 全都还能用（别改调用方）。
   ══════════════════════════════════════════════════════════════ */

import type { DiffFile } from './index'
import type { UsageBucket } from './models-extra'

export type ChatEvent =
  | { requestId: string; type: 'mode'; mode: string; confidence: number; reason: string }
  | {
      requestId: string
      type: 'route'
      role: string
      model: string
      provider: string
      reason: string
    }
  | { requestId: string; type: 'turn_start'; turn: number }
  /* AG-004：模型给了新的一版计划（和上一版一样就不发） */
  | { requestId: string; type: 'plan'; plan: string[]; version: number; reason: string }
  | { requestId: string; type: 'turn_end'; turn: number; usage: Record<string, number> | null }
  | { requestId: string; type: 'content'; text: string }
  | { requestId: string; type: 'reasoning'; text: string }
  | {
      requestId: string
      type: 'agent.tool.started'
      toolCallId: string
      name: string
      args: Record<string, unknown>
    }
  | {
      requestId: string
      /* AG-002：成败写在事件名里，前端不用再读 ok；服务端仍会带 ok，两者一致 */
      type: 'agent.tool.completed' | 'agent.tool.failed'
      toolCallId: string
      name: string
      ok: boolean
      result: string
      ms?: number
    }
  | {
      requestId: string
      type: 'confirm_request'
      confirmId: string
      toolName: string
      summary: string
      args: Record<string, unknown>
      kind?: string
      risk?: { level?: string } | null
      /** AG-036：会改成什么样 + 算不出时的说明（写文件类工具才有） */
      diff?: DiffFile[] | null
      diffNote?: string
    }
  | {
      requestId: string
      type: 'done'
      content: string
      reasoning: string
      usage: UsageBucket | null
      turns: number
      exhausted: boolean
    }
  | { requestId: string; type: 'aborted' }
  | { requestId: string; type: 'review'; status: 'started' | 'completed' }
  | {
      requestId: string
      type: 'budget'
      exceeded: boolean
      blocked: boolean
      level: 'day' | 'month' | null
      used: number
      limit: number
      message: string
    }
  /*
   * ②-5：碰到了能力边界（常驻后台 / 云同步 / 跨仓库…）。
   * **只是提示，不是拦** —— 消息照发、活照跑；判断「做不做得了」是用户的事。
   * 清单与判定在 `core/capability-bounds.cjs`。
   */
  | {
      requestId: string
      type: 'boundary'
      key: string
      level: 'never' | 'experimental'
      label: string
      note: string
      /** 命中的原文 —— 误报时用户才判断得出它是从哪句看出来的 */
      matched: string
    }
  | { requestId: string; type: 'error'; message: string }
  /* AG-001 + AG-002：生命周期事件。状态机每次转移推一条，事件名用标准名，
     **每条都带 phase** —— 前端只读 phase、不解析事件名，将来改名不影响渲染层。
     executing / responding 没有标准名，用 'phase' 发（它们是执行细节）。 */
  | {
      requestId: string
      type:
        | 'phase'
        | 'agent.started'
        | 'agent.thinking'
        | 'agent.planning'
        | 'agent.verification.started'
        | 'agent.verification.completed'
        | 'agent.waiting_user'
        | 'agent.paused'
        | 'agent.resumed'
        | 'agent.retrying'
        | 'agent.completed'
        | 'agent.failed'
        | 'agent.cancelled'
      /** 相位名（和主进程 lifecycle.cjs 的 13 个状态一致） */
      phase: string
      from: string
      detail?: string
    }
