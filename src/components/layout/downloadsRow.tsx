import { FolderOpen, Pause, Play, RotateCcw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fsReveal } from '@/lib/fsApi'
import {
  humanBytes,
  humanSpeed,
  percentOf,
  statusText,
  type DownloadItem,
} from '@/lib/downloadsApi'

/* ══════════════════════════════════════════════════════════════
   下载列表里的一行（从 `DownloadsPanel.tsx` 抽出来的）

   抽出来有两个理由：
     · 那边加完 P3 #28 的三处修正就越过 300 行了；
     · 「一条下载长什么样」和「整个队列怎么管」本来就是两件事 ——
       前者纯展示，后者有表单、限速与空态。

   ── P3 #28 的三处修正都在这里 ──────────────────────────────
    ① **总大小未知时不再假装 100%**：`total === 0` 表示服务器没给
       Content-Length，压根没有百分比可算。以前写死 `width:100%`，
       看着像「满了」而实际还在下。现在画不定态（短条 + 脉动）。
    ② **「移除记录」与磁盘文件分开命名**：那个垃圾桶只从列表里删记录，
       不碰文件 —— 文案必须说清，否则用户以为文件也没了。
    ③ **落盘路径露出来**：移除记录之后文件还在哪儿，用户得找得到；
       done 的行还给一个「在文件夹中显示」。
   ══════════════════════════════════════════════════════════════ */

const STATUS_STYLE: Record<string, string> = {
  running: 'text-accent',
  queued: 'text-fg-secondary',
  paused: 'text-warning',
  done: 'text-success',
  failed: 'text-danger',
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

export function DownloadsRow({
  item,
  onAct,
}: {
  item: DownloadItem
  onAct: (id: string, action: 'pause' | 'resume' | 'retry' | 'remove') => void
}) {
  const pct = percentOf(item)
  const active = item.status === 'running'
  /**
   * `pct === null` 就是「总大小未知」（见 `percentOf`）——
   * 这时候**没有百分比可算**，绝不能画成满格。
   */
  const unknownTotal = pct === null
  return (
    <div className="rounded-sm border border-line-subtle bg-bg-raised px-2 py-1.5">
      <div className="flex items-center gap-2">
        {item.origin === 'browser' ? (
          <span
            className="shrink-0 rounded-sm bg-bg-overlay px-1 text-2xs text-fg-tertiary"
            title="来自内置浏览器"
          >
            网页
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-2xs text-fg-primary" title={item.file}>
          {item.name}
        </span>
        <span className={cn('shrink-0 text-2xs', STATUS_STYLE[item.status] ?? 'text-fg-tertiary')}>
          {statusText(item.status)}
        </span>
      </div>

      {/* 进度条：有总大小画真实百分比；没有则画不定态 */}
      <div
        className="mt-1 h-1 overflow-hidden rounded-full bg-bg-hover"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(unknownTotal ? {} : { 'aria-valuenow': pct ?? 0 })}
        aria-label={unknownTotal ? '正在下载，总大小未知' : `已下载 ${pct ?? 0}%`}
      >
        <div
          className={cn(
            'h-full transition-all duration-200',
            active ? 'bg-accent' : 'bg-fg-tertiary',
            /* 不定态：固定长度的短条（进行中再配脉动）。减少动效时它就是静态短条 */
            unknownTotal && 'w-1/3',
            unknownTotal && active && 'animate-pulse',
          )}
          style={unknownTotal ? undefined : { width: `${pct ?? 0}%` }}
        />
      </div>

      <div className="mt-1 flex items-center gap-2 text-2xs text-fg-tertiary">
        <span className="font-mono">
          {unknownTotal
            ? `已收 ${humanBytes(item.received)}${active ? '（总大小未知）' : ''}`
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
          {item.status === 'done' ? (
            <IconBtn label="在文件夹中显示" onClick={() => void fsReveal(item.file)}>
              <FolderOpen size={12} />
            </IconBtn>
          ) : null}
          {/* 只从列表里移除这条记录，不碰磁盘上的文件 —— 文案必须说清 */}
          <IconBtn label="移除记录（不删除已下载的文件）" onClick={() => onAct(item.id, 'remove')}>
            <Trash2 size={12} />
          </IconBtn>
        </span>
      </div>
      {/* 落盘路径也露出来 —— 移除记录之后文件还在哪儿，用户得找得到 */}
      {item.file ? (
        <p className="mt-0.5 truncate text-2xs text-fg-tertiary" title={item.file}>
          {item.file}
        </p>
      ) : null}

      {item.status === 'failed' && item.error ? (
        <p className="mt-1 text-2xs text-danger" title={item.error}>
          {item.error}
        </p>
      ) : null}
    </div>
  )
}
