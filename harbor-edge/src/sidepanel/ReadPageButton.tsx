/**
 * 「读当前页」按钮（Phase 2 的能力；Phase 3b 布局返工把它挪到输入框左端）
 *
 * ── 为什么挪 ─────────────────────────────────────────────────
 *
 * 它原来在侧边栏顶部独占一块（大按钮 + 三行结果文字，见 App.tsx 的老布局）——
 * 400px 宽的面板里白吃一块高度。现在压成输入框左端的一个图标按钮，结果走
 * ChatPanel 那行状态文字（`role=status`，与发送提示共用同一个元素）。
 *
 * ── ★ 两条不能碰的规矩（Phase 2 定的，与本次布局无关）──────────
 *
 *   · 只读**前台当前标签**：`chrome.tabs.query({active:true,currentWindow:true})`
 *     且**只由用户点这一下发起**（见 service-worker.js 的 `read-page`）。
 *     没有任何定时器 / 监听器会自己去读页面。
 *   · 包装（`wrapWebText`）在主进程做，**这里不做任何包装** ——
 *     防注入的包装是内核的职责，扩展侧自己拼一份就会漂（硬约束 #9）。
 *
 * ── ⚠️ 可访问名字是验收脚本的锚点 ────────────────────────────
 *
 *   `aria-label="读当前页"` 被两处按名字找：
 *     · `lib/ext-probe.cjs` 的 `CLICK_READ_EXPR`
 *     · `tools/accept-phase3b.cjs` 的 `PANEL_READY`
 *   改名要同步改那两处，否则脚本静默失效（读不到元素、判据假红或假绿）。
 *   （按钮里那个图标本身**没有文字** —— 这正是必须靠 aria-label 找的原因。）
 */

/* global chrome */

import { useCallback, useState } from 'react'
import { FileText } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'

/** 给 ChatPanel 状态行用的一句话（`tone` 决定颜色） */
export interface StatusMessage {
  text: string
  tone: 'info' | 'danger'
}

/** SW `read-page` 的返回形状（见 service-worker.js） */
interface PageResult {
  ok: boolean
  error?: string | null
  url?: string
  title?: string
  chars?: number
  truncated?: boolean
}

export function ReadPageButton({ onStatus }: { onStatus: (s: StatusMessage | null) => void }) {
  const [reading, setReading] = useState(false)

  const read = useCallback(() => {
    if (reading) return
    setReading(true)
    onStatus({ text: '读取中…', tone: 'info' })
    try {
      const p = chrome.runtime.sendMessage({ type: 'read-page' })
      if (!p || typeof p.then !== 'function') {
        onStatus({ text: '扩展上下文不可用', tone: 'danger' })
        setReading(false)
        return
      }
      p.then((res: PageResult | undefined) => {
        setReading(false)
        if (res && res.ok === true) {
          const name = String(res.title || res.url || '')
          const cut = res.truncated ? '（正文过长，已截断）' : ''
          onStatus({
            text: `已读取 ${res.chars ?? 0} 字${name ? ` · ${name}` : ''}${cut}，已发进 Harbor 当前对话`,
            tone: 'info',
          })
          return
        }
        /* 失败也给**人话**（SW 那边已经转好了，这里不自己编） */
        onStatus({ text: String(res?.error ?? '没有拿到结果'), tone: 'danger' })
      }).catch((error: unknown) => {
        setReading(false)
        onStatus({ text: String((error as Error)?.message ?? error), tone: 'danger' })
      })
    } catch (error) {
      setReading(false)
      onStatus({ text: String((error as Error)?.message ?? error), tone: 'danger' })
    }
  }, [reading, onStatus])

  return (
    <IconButton
      /* ★ 这个名字是锚点（见文件头）—— 读取中也要能按它找到（脚本会点两次） */
      label="读当前页"
      disabled={reading}
      onClick={read}
    >
      <FileText size={16} aria-hidden="true" className={reading ? 'animate-pulse' : undefined} />
    </IconButton>
  )
}
