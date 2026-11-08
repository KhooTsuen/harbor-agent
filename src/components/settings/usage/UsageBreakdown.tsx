import type { UsageQueryBucket, UsageQueryResult } from '@/types/usage-query'
import { USAGE_TASK_NONE, USAGE_UNSET } from '@/types/usage-query'
import { formatCount } from '@/lib/format'
import { useUsageTabStore } from '@/stores/useUsageTabStore'
import { SectionTitle } from '../parts'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
    「模型用量」· 多维分析与排行

    ── 为什么排行要可点 ──────────────────────────────────────────
    看到「某个任务烧了 80% 的 token」，下一步一定想问「那它具体调了什么」。
    每行可点 = 一次点击就把它变成筛选条件，不用再去上面翻下拉框。

    ── 为什么任务排行必须标「未归属」 ────────────────────────────
    老记录 / 非任务路径（纯聊天）没有 taskId。把它们塞进某个具体任务名下就是
    编造归属；合并成一个「（未归属）」桶才是真相。

    ── 缓存与思考不单独进「合计」 ────────────────────────────────
    缓存命中含在 prompt 里、思考含在 completion 里 —— 所以这里只把它们作为
    补充列显示，**不参与任何加总**（否则总量会凭空变大）。
    ══════════════════════════════════════════════════════════════ */

/** 按 total 降序取前 N 项（数量大时列表不该无界增长） */
function topOf(
  map: Record<string, UsageQueryBucket>,
  limit = 8,
): Array<{ key: string; bucket: UsageQueryBucket }> {
  return Object.keys(map)
    .map((key) => ({ key, bucket: map[key] }))
    .sort((a, b) => b.bucket.total - a.bucket.total || b.bucket.requests - a.bucket.requests)
    .slice(0, limit)
}

/** 排行里的一行：左标题 + 用量条 + 右侧数字 */
function RankRow({
  label,
  bucket,
  max,
  active,
  onClick,
  sub,
}: {
  label: string
  bucket: UsageQueryBucket
  max: number
  active: boolean
  onClick: () => void
  /** 第二行补充说明（供应商 / 未归属提示等） */
  sub?: string
}): React.ReactElement {
  const ratio = max > 0 ? Math.max(2, (bucket.total / max) * 100) : 0
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex w-full flex-col gap-1 rounded-sm border px-2 py-1.5 text-left transition-colors duration-fast',
        active
          ? 'border-line-focus bg-bg-hover'
          : 'border-line-hairline bg-bg-raised/20 hover:bg-bg-hover',
      )}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-dense text-fg-primary" title={label}>
          {label}
        </span>
        <span className="shrink-0 font-mono text-2xs text-fg-secondary">
          {formatCount(bucket.total)}
        </span>
      </span>
      <span className="h-1 w-full overflow-hidden rounded-full bg-bg-surface">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${ratio}%`,
            background: 'color-mix(in srgb, var(--accent-blue) 65%, transparent)',
          }}
        />
      </span>
      <span className="text-2xs text-fg-tertiary">
        {bucket.requests} 次 · 已知 {bucket.known}
        {bucket.unknown > 0 ? ` / 未知 ${bucket.unknown}` : ''}
        {sub ? ` · ${sub}` : ''}
      </span>
    </button>
  )
}

interface Props {
  data: UsageQueryResult
}

export function UsageBreakdown({ data }: Props): React.ReactElement {
  const providerId = useUsageTabStore((s) => s.providerId)
  const model = useUsageTabStore((s) => s.model)
  const taskId = useUsageTabStore((s) => s.taskId)
  const setFilters = useUsageTabStore((s) => s.setFilters)
  const clearFilters = useUsageTabStore((s) => s.clearFilters)

  /* 排行取全量（不筛）那份数据才有意义 —— 否则筛完就只剩一行 */
  const models = topOf(data.byProviderModel)
  const tasks = topOf(data.byTask)
  const purposes = topOf(data.byPurpose, 10)

  const anyFilter = Boolean(providerId || model || taskId)

  /* 供应商为模型行提供副标题（同名模型分属两家时能看出来） */
  const subOfProviderModel = (key: string): string => {
    const one = data.byProviderModel[key]
    return one?.providerId ? one.providerId : ''
  }

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle hint="点任意一行把它变成筛选条件（再点一次取消）">多维分析</SectionTitle>

      {anyFilter ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-sm border border-line-hairline bg-bg-raised/30 px-2 py-1.5 text-2xs text-fg-secondary">
          <span>当前筛选：</span>
          {providerId ? <Chip label={`供应商 ${providerId}`} /> : null}
          {model ? <Chip label={`模型 ${model}`} /> : null}
          {taskId ? <Chip label={`任务 ${taskId}`} /> : null}
          <button
            type="button"
            onClick={clearFilters}
            className="ml-auto underline hover:text-fg-primary"
          >
            清空
          </button>
        </div>
      ) : null}

      <div className="grid gap-2 lg:grid-cols-2">
        {/* ── 按模型（含供应商，同名模型不合并）── */}
        <div className="flex flex-col gap-1">
          <p className="px-1 text-2xs text-fg-tertiary">按模型（同一个模型名分属两家时分开算）</p>
          {models.length === 0 ? (
            <p className="px-1 text-dense text-fg-tertiary">还没有任何模型调用记录。</p>
          ) : (
            models.map(({ key, bucket }) => {
              const one = data.byProviderModel[key]
              const label = one?.model || key
              const active = model === label && providerId === (one?.providerId ?? '')
              return (
                <RankRow
                  key={key}
                  label={label}
                  bucket={bucket}
                  max={models[0].bucket.total}
                  active={active}
                  sub={subOfProviderModel(key)}
                  onClick={() =>
                    setFilters(
                      active
                        ? { model: '', providerId: '' }
                        : { providerId: one?.providerId || '', model: label },
                    )
                  }
                />
              )
            })
          )}
        </div>

        {/* ── 按任务（Agent 特有的视角：一个任务烧在哪）── */}
        <div className="flex flex-col gap-1">
          <p className="px-1 text-2xs text-fg-tertiary">
            按任务（没归属的进「{USAGE_TASK_NONE}」，不猜）
          </p>
          {tasks.length === 0 ? (
            <p className="px-1 text-dense text-fg-tertiary">还没有任何任务归属记录。</p>
          ) : (
            tasks.map(({ key, bucket }) => (
              <RankRow
                key={key}
                label={key}
                bucket={bucket}
                max={tasks[0].bucket.total}
                active={taskId === key && key !== USAGE_TASK_NONE}
                sub={key === USAGE_TASK_NONE ? '无 taskId（老记录或纯聊天）' : ''}
                onClick={() =>
                  /* 「未归属」点不了：它不是某个具体任务，筛了也没意义 */
                  key === USAGE_TASK_NONE
                    ? undefined
                    : setFilters({ taskId: taskId === key ? '' : key })
                }
              />
            ))
          )}
        </div>
      </div>

      {/* ── 按调用类别（chat / summary / compact / scene / vision / prewarm / collab）── */}
      <div className="flex flex-col gap-1">
        <p className="px-1 text-2xs text-fg-tertiary">
          按调用类别（主对话 / 总结 / 压缩 / 场景 / 识图 / 预热 / 协作）
        </p>
        {purposes.length === 0 ? (
          <p className="px-1 text-dense text-fg-tertiary">还没有调用记录。</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {purposes.map(({ key, bucket }) => (
              <span
                key={key}
                className="flex items-center gap-1.5 rounded-sm border border-line-hairline bg-bg-raised/20 px-2 py-1 text-2xs text-fg-secondary"
              >
                <span className="text-fg-primary">{key === USAGE_UNSET ? USAGE_UNSET : key}</span>
                <span className="font-mono">{formatCount(bucket.total)}</span>
                <span className="text-fg-tertiary">
                  （{bucket.requests} 次，未知 {bucket.unknown}）
                </span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 缓存 / 思考单列一栏：它们是「包含关系」，不能和上面几栏相加 */}
      <details className="rounded-sm border border-line-hairline bg-bg-raised/20 px-3 py-2">
        <summary className="cursor-pointer text-dense text-fg-secondary">
          缓存与思考 token（含在输入 / 输出里，不额外相加）
        </summary>
        <div className="mt-1.5 grid grid-cols-2 gap-2 text-2xs text-fg-tertiary sm:grid-cols-4">
          <span>
            缓存命中
            <br />
            <span className="font-mono text-dense text-fg-primary">
              {formatCount(data.totals.cacheHit)}
            </span>
          </span>
          <span>
            缓存未命中
            <br />
            <span className="font-mono text-dense text-fg-primary">
              {formatCount(data.totals.cacheMiss)}
            </span>
          </span>
          <span>
            思考 token
            <br />
            <span className="font-mono text-dense text-fg-primary">
              {formatCount(data.totals.reasoning)}
            </span>
          </span>
          <span>
            字段未上报
            <br />
            <span className="font-mono text-dense text-fg-primary">
              {formatCount(data.totals.fieldUnavailable.cacheHit ?? 0)}
            </span>
          </span>
        </div>
      </details>
    </div>
  )
}

function Chip({ label }: { label: string }): React.ReactElement {
  return (
    <span className="rounded-sm border border-line-focus bg-bg-hover px-1.5 py-0.5 text-fg-primary">
      {label}
    </span>
  )
}
