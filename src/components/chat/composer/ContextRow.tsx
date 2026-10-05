import { AtSign, Slash } from 'lucide-react'

/* ══════════════════════════════════════════════════════════════
   输入框下面那行小字：工作目录 + 上下文用量 + 提文件/命令提示

   从 Composer.tsx 拆出来的（那边过 300 行了）。
   纯展示，不参与输入状态，拆开没有代价。
   ══════════════════════════════════════════════════════════════ */

import type { ThreadSettings } from '@/types'
import type { UiStatus } from '@/lib/statusLanguage'
import { colorOf } from '@/lib/statusLanguage'
import { Tooltip } from '@/components/ui/Tooltip'
import { useAppStore } from '@/stores/useAppStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { adviseCompact, modelWindowOf } from '@/stores/thread/compact'

/** 圈圈直径 / 描边（px）—— 2xs 的字号旁边，再大就抢眼了 */
const RING = 6
/** 环的周长（算 dash 用） */
const CIRC = 2 * Math.PI * RING

/**
 * 上下文用量圈（真机反馈 12c）。
 *
 * 口径与压缩完全同一份（`adviseCompact`）：如果这里和压缩各算各的，
 * 用户就会看到「圈才到 50%，它却自己压了」这种自相矛盾的事。
 *
 * 数据自己从 store 取，不让 Composer 多传三个 prop —— 那边贴着 300 行了。
 * 代价：消息每长一点就重算一次。这是纯长度估算（不序列化、不统计 token），
 * 上千条消息也就一次 reduce，可以接受。
 */
function ContextGauge() {
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))
  const cfg = useConfigStore((s) => s.config)
  if (!thread) return null

  const window = modelWindowOf(cfg?.capabilities, thread.model)
  const advice = adviseCompact(
    thread.messages,
    cfg?.context?.baseTokens ?? 0,
    { warn: cfg?.context?.compactAt, auto: cfg?.context?.autoCompactAt },
    window,
  )
  const pct = Math.max(0, Math.min(100, Math.round(advice.ratio * 100)))
  /* 颜色只从状态语言表取：过提醒线黄、过自动线红（那条线过了会真压） */
  const status: UiStatus = advice.auto ? 'failed' : advice.warn ? 'warning' : 'neutral'
  const color = colorOf(status)
  const detail = [
    `上下文 ${pct}%（估算 ${advice.used.toLocaleString()} / ${advice.limit.toLocaleString()} token）`,
    window
      ? `分母 = min(模型窗口 ${window.toLocaleString()} × 80%, 你的上限)`
      : '没有这个模型的窗口数据，分母只用你的上限',
    advice.auto ? '已经超过自动压缩线 —— 下一轮会自动压缩' : advice.warn ? '快到自动压缩线了' : '',
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <Tooltip content={detail}>
      <span className="flex shrink-0 items-center gap-1" role="status" aria-label={detail}>
        <svg
          width={RING * 2 + 2}
          height={RING * 2 + 2}
          viewBox={`0 0 ${RING * 2 + 2} ${RING * 2 + 2}`}
        >
          {/* 底环：永远看得见，空的时候也占位（不然数字一变行就跳） */}
          <circle
            cx={RING + 1}
            cy={RING + 1}
            r={RING}
            fill="none"
            stroke={color}
            strokeOpacity={0.25}
            strokeWidth={1.5}
          />
          {/* 用量弧：从 12 点开始顺时针 */}
          <circle
            cx={RING + 1}
            cy={RING + 1}
            r={RING}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - Math.min(1, advice.ratio))}
            transform={`rotate(-90 ${RING + 1} ${RING + 1})`}
          />
        </svg>
        <span className="font-mono">{pct}%</span>
      </span>
    </Tooltip>
  )
}

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
        <ContextGauge />
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
