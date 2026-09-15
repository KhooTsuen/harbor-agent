import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   Skeleton —— 加载骨架
   ══════════════════════════════════════════════════════════════ */

export interface SkeletonProps {
  className?: string
  /** 行数，给文字块用 */
  lines?: number
}

export function Skeleton({ className, lines }: SkeletonProps) {
  if (lines && lines > 0) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: lines }, (_, i) => (
          <div
            key={i}
            className={cn('h-3 animate-pulse rounded-sm bg-bg-raised', className)}
            style={{ width: i === lines - 1 ? '62%' : '100%' }}
          />
        ))}
      </div>
    )
  }
  return <div className={cn('animate-pulse rounded-sm bg-bg-raised', className)} />
}

/** 消息加载骨架 */
export function MessageSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-6 py-4">
      <Skeleton className="h-3 w-24" />
      <Skeleton lines={3} />
    </div>
  )
}

/** 侧边栏加载骨架 */
export function SidebarSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-8" />
      ))}
    </div>
  )
}
