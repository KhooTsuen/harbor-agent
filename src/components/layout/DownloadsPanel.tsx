import { useEffect, useState } from 'react'
import { Download, Pause, Play, RotateCcw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui/EmptyState'
import { subscribeDownloadsEvent } from '@/lib/subscriptions'
import {
  humanBytes,
  humanSpeed,
  percentOf,
  statusText,
  type DownloadItem,
} from '@/lib/downloadsApi'
import { useDownloadsStore } from '@/stores/useDownloadsStore'

/* ══════════════════════════════════════════════════════════════
   右栏「下载」标签：任务队列 + 限速 + 进度

   进度是**推**来的（`downloads:event`），组件挂载时先拉一次整表补状态。
   后端是唯一真相源，这里不自己算「还剩多久」之类会漂的东西。
   ══════════════════════════════════════════════════════════════ */

const STATUS_STYLE: Record<string, string> = {
  running: 'text-accent',
  queued: 'text-fg-secondary',
  paused: 'text-warning',
  done: 'text-success',
  failed: 'text-danger',
}

function Row({
  item,
  onAct,
}: {
  item: DownloadItem
  onAct: (id: string, action: 'pause' | 'resume' | 'retry' | 'remove') => void
}) {
  const pct = percentOf(item)
  const active = item.status === 'running'
  return (
    <div className="rounded-sm border border-line-subtle bg-bg-raised px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-2xs text-fg-primary" title={item.file}>
          {item.name}
        </span>
        <span className={cn('shrink-0 text-2xs', STATUS_STYLE[item.status] ?? 'text-fg-tertiary')}>
          {statusText(item.status)}
        </span>
      </div>

      {/* 进度条：total 未知（服务器没给 content-length）时只显示已收字节 */}
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-hover">
        <div
          className={cn(
            'h-full transition-all duration-200',
            active ? 'bg-accent' : 'bg-fg-tertiary',
          )}
          style={{ width: pct === null ? (active ? '100%' : '0%') : `${pct}%` }}
        />
      </div>

      <div className="mt-1 flex items-center gap-2 text-2xs text-fg-tertiary">
        <span className="font-mono">
          {pct === null
            ? `已收 ${humanBytes(item.received)}`
            : `${pct}% · ${humanBytes(item.received)} / ${humanBytes(item.total)}`}
        </span>
        {item.speedBps > 0 ? <span className="font-mono">{humanSpeed(item.speedBps)}</span> : null}
        {item.attempts > 1 ? <span>· 第 {item.attempts} 次</span> : null}
        <span className="ml-auto flex items-center gap-1">
          {active ? (
            <IconBtn label="暂停" onClick={() => onAct(item.id, 'pause')}>
              <Pause size={12} />
            </IconBtn>
          ) : item.status === 'done' ? null : item.status === 'failed' ? (
            <IconBtn label="重试" onClick={() => onAct(item.id, 'retry')}>
              <RotateCcw size={12} />
            </IconBtn>
          ) : (
            <IconBtn label="继续" onClick={() => onAct(item.id, 'resume')}>
              <Play size={12} />
            </IconBtn>
          )}
          <IconBtn label="删除" onClick={() => onAct(item.id, 'remove')}>
            <Trash2 size={12} />
          </IconBtn>
        </span>
      </div>

      {item.status === 'failed' && item.error ? (
        <p className="mt-1 text-2xs text-danger" title={item.error}>
          {item.error}
        </p>
      ) : null}
    </div>
  )
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex size-5 items-center justify-center rounded-sm text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
    >
      {children}
    </button>
  )
}

export function DownloadsPanel() {
  const items = useDownloadsStore((s) => s.items)
  const running = useDownloadsStore((s) => s.running)
  const limits = useDownloadsStore((s) => s.limits)
  const error = useDownloadsStore((s) => s.error)
  const loaded = useDownloadsStore((s) => s.loaded)
  const refresh = useDownloadsStore((s) => s.refresh)
  const applyEvent = useDownloadsStore((s) => s.applyEvent)
  const act = useDownloadsStore((s) => s.act)
  const add = useDownloadsStore((s) => s.add)
  const clearFinished = useDownloadsStore((s) => s.clearFinished)
  const setLimits = useDownloadsStore((s) => s.setLimits)

  const [url, setUrl] = useState('')
  const [path, setPath] = useState('')
  const [formError, setFormError] = useState('')

  useEffect(() => {
    void refresh()
    return subscribeDownloadsEvent(applyEvent)
  }, [refresh, applyEvent])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setFormError('')
    const result = await add(url.trim(), path.trim())
    if (!result.ok) setFormError(result.error ?? '加入失败')
    else {
      setUrl('')
      setPath('')
    }
  }

  const runningCount = running.length || items.filter((i) => i.status === 'running').length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line-subtle px-3 py-2 text-2xs">
        <span className="text-fg-secondary">下载队列</span>
        <span className="text-fg-tertiary">{runningCount} 个在跑</span>
        <button
          type="button"
          onClick={() => void clearFinished()}
          className="ml-auto rounded-sm px-1.5 py-0.5 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          清空已完成
        </button>
      </div>

      {/* 限速 / 并发：改动立刻对正在跑的任务生效（内核读的是同一份配置） */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line-subtle px-3 py-1.5 text-2xs text-fg-tertiary">
        <label className="flex items-center gap-1">
          并发
          <select
            value={limits.maxConcurrent}
            onChange={(e) => void setLimits({ maxConcurrent: Number(e.target.value) })}
            className="rounded-sm border border-line-subtle bg-bg-base px-1 py-0.5 text-fg-primary"
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          连接
          <select
            value={limits.connections}
            onChange={(e) => void setLimits({ connections: Number(e.target.value) })}
            className="rounded-sm border border-line-subtle bg-bg-base px-1 py-0.5 text-fg-primary"
          >
            {[1, 2, 4, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          限速
          <input
            type="number"
            min={0}
            value={limits.maxKBps}
            onChange={(e) => void setLimits({ maxKBps: Math.max(0, Number(e.target.value) || 0) })}
            className="w-16 rounded-sm border border-line-subtle bg-bg-base px-1 py-0.5 text-fg-primary"
          />
          KB/s（0 = 不限）
        </label>
      </div>

      <form
        onSubmit={submit}
        className="flex shrink-0 flex-col gap-1 border-b border-line-subtle px-3 py-2"
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http/https 地址"
          aria-label="下载地址"
          className="rounded-sm border border-line-subtle bg-bg-base px-2 py-1 text-2xs text-fg-primary placeholder:text-fg-tertiary"
        />
        <div className="flex items-center gap-1">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="保存到（相对工作目录，或绝对路径）"
            aria-label="保存路径"
            className="min-w-0 flex-1 rounded-sm border border-line-subtle bg-bg-base px-2 py-1 text-2xs text-fg-primary placeholder:text-fg-tertiary"
          />
          <button
            type="submit"
            disabled={!url.trim() || !path.trim()}
            className="shrink-0 rounded-sm bg-accent px-2 py-1 text-2xs text-fg-on-emphasis transition-opacity disabled:opacity-40"
          >
            下载
          </button>
        </div>
        {formError ? <p className="text-2xs text-danger">{formError}</p> : null}
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={<Download size={28} />}
              title={loaded && error ? '读不到下载列表' : '还没有下载任务'}
              description={
                loaded && error
                  ? error
                  : '在上面填地址和保存路径，或让 Agent 用 download 工具下载 —— 两边共用同一个队列。'
              }
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {items.map((item) => (
              <Row key={item.id} item={item} onAct={act} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
