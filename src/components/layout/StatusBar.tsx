import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { formatCount, formatTokens } from '@/lib/format'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'
import { colorOf, statusOfPhase } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   StatusBar（高 28px）—— 窗口最底下那一条

   从 TopBar.tsx 拆出来的：那边原本顶栏和状态栏住在一个文件里，
   现在顶栏升级成了横跨整个窗口的 AppTitleBar，剩下这条自己独立。
   ══════════════════════════════════════════════════════════════ */

export function StatusBar() {
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))

  /* 当前会话的 token 用量：把每条回复身上的 usage 加起来 */
  const tokens = useMemo(() => {
    let prompt = 0
    let completion = 0
    for (const message of thread?.messages ?? []) {
      if (!message.usage) continue
      prompt += message.usage.prompt ?? 0
      completion += message.usage.completion ?? 0
    }
    return { prompt, completion, total: prompt + completion }
  }, [thread])

  /*
   * 工作目录只在 Composer 下面显示一次；状态栏不再重复。
   * （同一份信息出现两处，用户会以为是两个不同的目录。）
   */
  /* 状态栏说的是「应用整体忙不忙」—— 任意一条对话在跑都算 */
  const sending = useThreadStore((s) => s.sendingThreads.length > 0)
  /* 生图任务：异步的，主进程每 3 秒推一次状态（见 core/image-watch.cjs） */
  const imageTask = useUIStore((s) => s.imageTask)
  const mode = thread?.mode ?? 'pair'

  return (
    <footer
      className="glass-panel flex shrink-0 items-center gap-3 border-t border-line-subtle px-3 text-2xs text-fg-tertiary"
      style={{ height: 28 }}
    >
      <span className="flex items-center gap-1.5">
        <span
          className={cn('inline-block size-1.5 rounded-full', sending && 'animate-pulse')}
          style={{ background: colorOf(statusOfPhase(sending ? 'executing' : 'completed')) }}
        />
        {sending ? '生成中' : '就绪'}
      </span>

      {/*
        生图进度。生图是异步的（上游排队 + 出图），光转圈看不出在干什么 ——
        这里把上游状态和已等待时间直接摊开，用户一眼知道是排队还是正在画。
      */}
      {imageTask ? (
        <span className="flex items-center gap-1.5" style={{ color: colorOf('running') }}>
          <span
            className="inline-block size-1.5 animate-pulse rounded-full"
            style={{ background: colorOf('running') }}
          />
          {imageTaskLabel(imageTask.status)}
          {imageTask.elapsedMs > 0 ? ` · 已等待 ${Math.round(imageTask.elapsedMs / 1000)} 秒` : ''}
        </span>
      ) : null}

      <span className="font-mono">{mode}</span>
      <span className="font-mono">{thread?.model ?? '—'}</span>
      <span className="hidden font-mono sm:inline">{thread?.reasoning ?? '—'}</span>

      {/* token 用量：位置紧张，只用 ↑↓ 加缩写，完整数字挂 title */}
      {tokens.total > 0 ? (
        <span
          className="ml-auto hidden shrink-0 font-mono md:inline"
          title={`本会话 token：输入 ${formatCount(tokens.prompt)} · 输出 ${formatCount(tokens.completion)} · 合计 ${formatCount(tokens.total)}`}
        >
          ↑{formatTokens(tokens.prompt)} ↓{formatTokens(tokens.completion)}
        </span>
      ) : null}
    </footer>
  )
}

/** 上游状态 → 人话。APIMart 文档：长时间 SUBMITTED 就是排队中 */
function imageTaskLabel(status?: string): string {
  const value = String(status ?? '').toLowerCase()
  if (value === 'submitted' || value === 'pending' || value === 'not_start') return '画图 · 排队中'
  if (value === 'processing' || value === 'in_progress') return '画图 · 正在生成'
  return '画图 · 进行中'
}
