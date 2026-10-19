import { useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { fileNameFromUrl, joinTarget } from '@/lib/downloadsApi'
import { useDownloadsStore } from '@/stores/useDownloadsStore'
import { DownloadsRow } from './downloadsRow'

/* ══════════════════════════════════════════════════════════════
   右栏「下载」标签：任务队列 + 限速 + 进度

   进度是**推**来的（`downloads:event`）—— 但订阅不在这个文件里：
   这个面板按标签条件渲染（`RightPanel.tsx`），订阅放这儿的话，用户在内置
   浏览器里点下载时面板根本没挂载、事件没人接（2026-10-11 真机踩到）。
   现在订阅常驻在 `hooks/useDownloadNotifications.ts`，这里只管渲染，
   挂载时拉一次整表补状态。后端依然是唯一真相源。
   ══════════════════════════════════════════════════════════════ */

export function DownloadsPanel() {
  const items = useDownloadsStore((s) => s.items)
  const running = useDownloadsStore((s) => s.running)
  const limits = useDownloadsStore((s) => s.limits)
  const error = useDownloadsStore((s) => s.error)
  const loaded = useDownloadsStore((s) => s.loaded)
  const refresh = useDownloadsStore((s) => s.refresh)
  const act = useDownloadsStore((s) => s.act)
  const add = useDownloadsStore((s) => s.add)
  const clearFinished = useDownloadsStore((s) => s.clearFinished)
  const setLimits = useDownloadsStore((s) => s.setLimits)

  const [url, setUrl] = useState('')
  const [dir, setDir] = useState('')
  const [name, setName] = useState('')
  const [formError, setFormError] = useState('')
  /** 上一次由地址自动带出的文件名 —— 用户手改过之后就不再覆盖它 */
  const autoNameRef = useRef('')

  /** 地址一变就带出文件名；只在「空着」或「还是上次自动那个」时才覆盖 */
  const changeUrl = (value: string) => {
    setUrl(value)
    const guess = fileNameFromUrl(value)
    setName((current) => (current === '' || current === autoNameRef.current ? guess : current))
    autoNameRef.current = guess
  }

  useEffect(() => {
    void refresh()
  }, [refresh])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setFormError('')
    const result = await add(url.trim(), joinTarget(dir, name))
    if (!result.ok) setFormError(result.error ?? '加入失败')
    else {
      setUrl('')
      setDir('')
      setName('')
      autoNameRef.current = ''
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
          title="只清理列表里已完成 / 已失败的记录，磁盘上的文件不受影响"
          className="ml-auto rounded-sm px-1.5 py-0.5 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          清理已完成记录
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
          onChange={(e) => changeUrl(e.target.value)}
          placeholder="http/https 地址"
          aria-label="下载地址"
          className="rounded-sm border border-line-subtle bg-bg-base px-2 py-1 text-2xs text-fg-primary placeholder:text-fg-tertiary"
        />
        <div className="flex items-center gap-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="文件名"
            aria-label="文件名"
            className="min-w-0 flex-1 rounded-sm border border-line-subtle bg-bg-base px-2 py-1 text-2xs text-fg-primary placeholder:text-fg-tertiary"
          />
          <input
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="保存到文件夹（留空 = 工作目录）"
            aria-label="保存文件夹"
            className="min-w-0 flex-1 rounded-sm border border-line-subtle bg-bg-base px-2 py-1 text-2xs text-fg-primary placeholder:text-fg-tertiary"
          />
          <button
            type="submit"
            disabled={!url.trim() || !name.trim()}
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
                  : '填地址和文件名（文件夹留空就存到工作目录），或让 Agent 用 download 工具下载 —— 两边共用同一个队列。'
              }
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {items.map((item) => (
              <DownloadsRow key={item.id} item={item} onAct={act} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
