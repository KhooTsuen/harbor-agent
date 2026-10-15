/**
 * 「观察页面」按钮（M03 新增；与 `ReadPageButton` 平行，是**两个不同的动作**）
 *
 * ── 与「读当前页」的区别（别混）──────────────────────────────
 *
 *   · **读当前页**：把整页正文读出来 → 送进 Harbor（Phase 2 起）。
 *   · **观察页面**（这个）：读**结构** —— 选区、可交互元素列表（带引用）、
 *     iframe 能不能读、以及**页面版本号**。M04 的「点 / 填 / 验证」全建在它上面。
 *
 * 结果同样走 `ChatPanel` 那行状态文字（`role=status`，与发送提示共用一个元素）。
 *
 * ── ⚠️ 可访问名字是验收脚本的锚点 ────────────────────────────
 *
 *   `aria-label="观察页面"` —— 改名的同步清单在 `lib/ext-probe-panel.cjs` 文件头的
 *   锚点归属表。图标按钮**没有可见文字**，只能靠 aria-label 找（改了脚本静默失效）。
 */

/* global chrome */

import { useCallback, useState } from 'react'
import { ScanSearch } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import type { StatusMessage } from './ReadPageButton'

/** SW `observe-page` 的返回形状（见 extension/lib/observe-run.js） */
interface ObserveResult {
  ok: boolean
  error?: string | null
  title?: string
  pageVersion?: string
  elements?: number
  hasSelection?: boolean
}

export function ObserveButton({ onStatus }: { onStatus: (s: StatusMessage | null) => void }) {
  const [busy, setBusy] = useState(false)

  const run = useCallback(() => {
    if (busy) return
    setBusy(true)
    onStatus({ text: '观察中…', tone: 'info' })
    try {
      const p = chrome.runtime.sendMessage({ type: 'observe-page' })
      if (!p || typeof p.then !== 'function') {
        onStatus({ text: '扩展上下文不可用', tone: 'danger' })
        setBusy(false)
        return
      }
      p.then((res: ObserveResult | undefined) => {
        setBusy(false)
        if (res && res.ok === true) {
          const name = String(res.title || '')
          const sel = res.hasSelection ? ' · 含选区' : ''
          onStatus({
            text: `已观察 ${res.elements ?? 0} 个可交互元素${sel}${name ? ` · ${name}` : ''} · 版本 ${res.pageVersion ?? ''}，已发进 Harbor 当前对话`,
            tone: 'info',
          })
          return
        }
        /* 失败也给**人话**（SW 那边已经转好了，这里不自己编） */
        onStatus({ text: String(res?.error ?? '没有拿到观察结果'), tone: 'danger' })
      }).catch((error: unknown) => {
        setBusy(false)
        onStatus({ text: String((error as Error)?.message ?? error), tone: 'danger' })
      })
    } catch (error) {
      setBusy(false)
      onStatus({ text: String((error as Error)?.message ?? error), tone: 'danger' })
    }
  }, [busy, onStatus])

  return (
    <IconButton label="观察页面" disabled={busy} onClick={run}>
      <ScanSearch size={16} aria-hidden="true" className={busy ? 'animate-pulse' : undefined} />
    </IconButton>
  )
}
