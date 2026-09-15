import { AtSign, Slash } from 'lucide-react'

/* ══════════════════════════════════════════════════════════════
   输入框下面那行小字：工作目录 + 提文件/命令提示

   从 Composer.tsx 拆出来的（那边过 300 行了）。
   纯展示，不参与输入状态，拆开没有代价。
   ══════════════════════════════════════════════════════════════ */

import type { ThreadSettings } from '@/types'

export function ComposerContextRow({
  threadWorkdir,
  status,
  settings,
}: {
  threadWorkdir: string
  status?: string
  settings?: ThreadSettings
}) {
  return (
    <div className="mt-1.5 flex items-center gap-x-3 px-1 text-2xs text-fg-tertiary">
      {/* 工作目录只在这一处显示（右栏和状态栏都不再重复） */}
      <span className="flex min-w-0 flex-1 items-center gap-1" title={`工作目录：${threadWorkdir}`}>
        <span aria-hidden="true" className="shrink-0">
          ⌂
        </span>
        <span className="min-w-0 truncate">{threadWorkdir}</span>
        {status ? <span className="ml-1 shrink-0 text-warning">· {status}</span> : null}
      </span>

      <span className="flex shrink-0 items-center gap-1.5">
        {settings?.allowNetwork === false ? <span>不联网</span> : null}
        {settings?.allowTools === false ? <span>禁工具</span> : null}
        {settings?.allowWrite === false ? <span>只读</span> : null}
        {settings?.useMemory === false ? <span>无记忆</span> : null}
        <AtSign size={11} />
        提文件
        <Slash size={11} className="ml-1" />
        命令
      </span>
    </div>
  )
}
