/**
 * 侧边栏的**悬停操作条**（复制正文 / 复制完整记录 / 时间戳）—— 2026-11-04
 *
 * ── 它解决什么 ────────────────────────────────────────────────
 *
 * 主窗口每条回复悬停时会出现一条操作条（`message/AssistantActions.tsx`），
 * 侧边栏没有 —— 同一段对话在两处能做的事不一样，这是「分裂感」里很实的一条。
 *
 * ── 为什么能复用、复用的是什么 ────────────────────────────────
 *
 * **复用**（纯函数 / 纯映射，两边必须同一份，硬约束 #9）：
 *   · `@/lib/export` 的 `fullRecordText` —— 「复制完整记录」的正文拼法（含过程区）
 *   · `@/lib/statusLanguage` 的 `colorOf` —— 状态色只有一处定义
 *   · `@/lib/utils` 的 `clockTime` —— 时间戳怎么写成「03:24」
 *
 * **不能复用** `AssistantActions` 组件本身：它吃整条 `Message`，还要
 * `useAppStore` / `useThreadStore` / `useUIStore` 三个 store（分支、继续、重生成、
 * toast）。侧边栏没有那几个动作（改 IPC 通道是硬禁区，见本任务 C 项结论），
 * 硬套等于给侧边栏挂一堆点不动的按钮。
 *
 * 所以这里只补一个「形状翻译」：侧边栏那条（`SideMessage`）→ 主窗口那个
 * `Message`，**只补齐必填项、不改名**（`text` → `content` 是唯一真正的改名，
 * 因为内核与主窗口各用各的名字，硬约束 #9 认可的那一处对齐点在 `mergeMessages`
 * 的文件头已经写明）。
 *
 * ── 时间戳为什么在悬停条末尾 ──────────────────────────────────
 *
 * 主窗口 `UserMessage` 就是这么做的（常显在气泡里会把 400px 面板挤得更窄）。
 * 用户明确要求「用 SideMessage 已有的 timestamp，别常显在气泡里」。
 */

import { useState } from 'react'
import { Check, Copy, FileText, XCircle } from 'lucide-react'
import type { Message } from '@/types'
import { colorOf } from '@/lib/statusLanguage'
import { fullRecordText } from '@/lib/export'
import { clockTime } from '@/lib/utils'
import { asRunRecords } from './ToolGroup'
import type { SideMessage } from './mergeMessages'

/** 复制结果（空串 = 还没点过） */
type CopyState = '' | 'text' | 'full' | 'fail'

/** 按钮的观感与主窗口 `AssistantActions` 同款（那几条类名照抄，见文件头的「已知遗留」） */
const BTN = 'rounded p-1 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary'

/**
 * 侧边栏那条 → 主窗口 `Message`（**只补齐必填项、不改名**）。
 *
 * `fullRecordText` 读的是 `role` / `content` / `reasoning` / `toolRuns` /
 * `interrupted` / `durationMs` / `status` —— 这几个侧边栏都有对应项。
 * `threadId` 给空串：复制记录用不到它（那个字段是给「按对话记住展开状态」用的）。
 */
function asRecordMessage(m: SideMessage): Message {
  const runs = m.toolRuns ? asRunRecords(m.toolRuns) : []
  return {
    id: m.id,
    threadId: '',
    role: m.role,
    content: m.text,
    kind: 'text',
    /* 出错 → error：`fullRecordText` 靠它决定要不要在末尾说「这次没能完成」 */
    status: m.error ? 'error' : 'sent',
    timestamp: m.timestamp ?? 0,
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    ...(runs.length > 0 ? { toolRuns: runs } : {}),
    ...(m.interrupted ? { interrupted: true } : {}),
    ...(m.durationMs ? { durationMs: m.durationMs } : {}),
  }
}

/**
 * 往剪贴板写一段字。
 *
 * ★ 侧边栏是 `chrome-extension://` 页面：`navigator.clipboard` 在有的环境里
 *   会因为「页面没焦点」被拒（面板刚点开、焦点还在网页上就会撞到）。所以失败时
 *   退一次 `execCommand('copy')` —— 不是新方案，是同一个动作的老通道。
 *
 * @returns 真的写进去了没有（界面据此决定画对勾还是红叉）
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const box = document.createElement('textarea')
      box.value = text
      box.setAttribute('readonly', '')
      box.style.position = 'fixed'
      box.style.opacity = '0'
      document.body.appendChild(box)
      box.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(box)
      return ok
    } catch {
      return false
    }
  }
}

/**
 * 一条消息的悬停操作条。
 *
 * @param props.message 要操作的那条
 * @param props.copy 给不给复制按钮（用户那条只放时间戳 —— 主窗口用户条也没有复制）
 * @param props.align 用户那条靠右，助手那条靠左（与气泡方向一致）
 */
export function SideActions({
  message,
  copy = false,
  align = 'start',
}: {
  message: SideMessage
  copy?: boolean
  align?: 'start' | 'end'
}) {
  const [state, setState] = useState<CopyState>('')

  /**
   * 有没有「正文之外的东西」可复制 —— 判据与主窗口 `AssistantActions` 同一套
   * （思考或工具至少有一个），而且不把状态算进去。
   */
  const hasRecord = Boolean(message.reasoning?.trim()) || (message.toolRuns?.length ?? 0) > 0

  async function run(kind: 'text' | 'full'): Promise<void> {
    const ok = await writeClipboard(
      kind === 'full' ? fullRecordText(asRecordMessage(message)) : message.text,
    )
    setState(ok ? kind : 'fail')
    window.setTimeout(() => setState(''), 1400)
  }

  return (
    <div
      className={`mt-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-fast group-hover:opacity-100 focus-within:opacity-100 ${
        align === 'end' ? 'justify-end' : ''
      }`}
    >
      {copy ? (
        <>
          <button
            type="button"
            aria-label={state === 'text' ? '已复制' : '复制回复'}
            title="复制（只有正文）"
            onClick={() => void run('text')}
            className={BTN}
          >
            {state === 'text' ? (
              <Check size={13} style={{ color: colorOf('completed') }} />
            ) : (
              <Copy size={13} />
            )}
          </button>
          {/* 没有过程就不挂第二颗 —— 点了会得到和「复制」一模一样的内容，那是骗人的 */}
          {hasRecord ? (
            <button
              type="button"
              aria-label={state === 'full' ? '已复制完整记录' : '复制完整记录'}
              title="复制完整记录（含思考、工具与状态）"
              onClick={() => void run('full')}
              className={BTN}
            >
              {state === 'full' ? (
                <Check size={13} style={{ color: colorOf('completed') }} />
              ) : (
                <FileText size={13} />
              )}
            </button>
          ) : null}
        </>
      ) : null}
      {state === 'fail' ? (
        <span className="flex items-center gap-0.5 text-2xs" style={{ color: colorOf('failed') }}>
          <XCircle size={11} />
          复制失败
        </span>
      ) : null}
      {message.timestamp && message.timestamp > 0 ? (
        <span className="pr-0.5 text-2xs text-fg-tertiary">{clockTime(message.timestamp)}</span>
      ) : null}
    </div>
  )
}
