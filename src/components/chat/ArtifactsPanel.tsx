import { useEffect, useMemo, useState } from 'react'
import { FileCode2, ExternalLink } from 'lucide-react'
import type { Artifact } from '@/types'
import type { ArtifactRecord } from '@/types/models-extra'
import { useAppStore } from '@/stores/useAppStore'
import { useTaskStore } from '@/stores/useTaskStore'
import { useUIStore } from '@/stores/useUIStore'
import { fsReveal } from '@/lib/fsApi'
import { artifactList } from '@/lib/artifactApi'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   成果面板

   数据源两层（优先内核，②的「最小接线」）：
     ① 内核 `artifact:list` —— 有版本历史、关掉会话也还在
     ② 前端内存汇总       —— **降级路径**：浏览器预览、或 preload 还没接上时用，
                             行为与以前一模一样（不因为桥没接好就白屏）

   面板只列元信息（名字 / 类型 / 版本 / 路径），正文要用时再按版本去取。

   ── P2 #27：范围（当前对话 / 项目 / 全部）──────────────────────
   切换范围**只过滤显示**，不改磁盘上的任何记录归属 —— 内核那边的
   `threadId` 是落盘时写的，面板这里只读。范围只是「我这次想看多大一圈」。

   项目范围按**当前对话的 projectId** 圈定同项目的其它对话，再按它们的
   threadId 过滤成果；没有项目的对话（纯聊天）在项目范围里只有它自己。
   ══════════════════════════════════════════════════════════════ */

type Scope = 'thread' | 'project' | 'all'

const SCOPES: readonly { id: Scope; label: string }[] = [
  { id: 'thread', label: '当前对话' },
  { id: 'project', label: '项目' },
  { id: 'all', label: '全部' },
]

/**
 * 这个范围允许看哪些对话的成果（P2 #27）。
 *
 * `null` = 不过滤（全部）。判据只此一处，组件与测试共用 ——
 * 单独抽出来是因为「项目范围」有一条容易错的分支：没有项目的对话
 * （纯聊天）不该被卷进任何项目。
 */
export function allowedThreadsOf(
  scope: Scope,
  threads: ReadonlyArray<{ id: string; projectId?: string }>,
  activeThreadId: string,
): Set<string> | null {
  if (scope === 'all') return null
  const active = threads.find((t) => t.id === activeThreadId)
  if (!active) return new Set()
  if (scope === 'thread') return new Set([active.id])
  if (!active.projectId) return new Set([active.id])
  return new Set(threads.filter((t) => t.projectId === active.projectId).map((t) => t.id))
}

type Row = {
  id: string
  name: string
  type: string
  path?: string
  note: string
}

export function ArtifactsPanel() {
  const threads = useAppStore((s) => s.threads)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const [kernel, setKernel] = useState<ArtifactRecord[] | null>(null)
  const [scope, setScope] = useState<Scope>('thread')
  /* 打不开的路径 → 就地标红，不再假装「可用」 */
  const [dead, setDead] = useState<Record<string, boolean>>({})
  const showToast = useUIStore((s) => s.showToast)

  /*
   * Phase 1 · B3：「成果」与「工作区文件修改」是**两回事**，别让用户以为
   * 「Agent 写了文件 → 成果面板里就该有」。写文件进的是「审查」（改动事务），
   * 只有**正式产出**（带文件名的代码块 / 内核登记的 artifact）才进这里。
   * 空态时给一个去「审查」的入口，省得用户以为文件丢了。
   */
  const diffCount = useTaskStore((s) => s.diff?.files.length ?? 0)
  const setActiveRightTab = useUIStore((s) => s.setActiveRightTab)

  /* 内核侧：拿不到（没桥 / 内核里还没落过成果）就留 null，由下面落到内存汇总 */
  useEffect(() => {
    let alive = true
    void artifactList().then((rows) => {
      if (alive) setKernel(rows)
    })
    return () => {
      alive = false
    }
  }, [])

  /* 降级路径：把各会话消息里的 artifacts 汇总去重（改动前的行为，一字未动） */
  const memory = useMemo(() => {
    const seen = new Set<string>()
    const result: Array<Artifact & { threadTitle: string; threadId?: string }> = []
    for (const thread of threads) {
      for (const message of thread.messages) {
        for (const artifact of message.artifacts ?? []) {
          if (seen.has(artifact.id)) continue
          seen.add(artifact.id)
          result.push({ ...artifact, threadTitle: thread.title, threadId: thread.id })
        }
      }
    }
    return result
  }, [threads])

  /** 这个范围允许哪些对话的成果（null = 不过滤） */
  const allowed = useMemo<Set<string> | null>(
    () => allowedThreadsOf(scope, threads, activeThreadId),
    [scope, threads, activeThreadId],
  )

  const rows = useMemo<Row[]>(() => {
    const threadOf = (id?: string) => threads.find((t) => t.id === id)
    const inScope = (threadId?: string): boolean =>
      !allowed || (!!threadId && allowed.has(threadId))

    if (kernel && kernel.length > 0) {
      return kernel
        .filter((artifact) => inScope(artifact.threadId))
        .map((artifact) => {
          const title = threadOf(artifact.threadId)?.title
          const count = artifact.versions.length
          return {
            id: artifact.id,
            name: artifact.name,
            type: artifact.type,
            path: artifact.path,
            note: `${title ?? '成果库'} · ${artifact.type} · 第 ${artifact.version} 版${
              count > 1 ? `（共 ${count} 版）` : ''
            }`,
          }
        })
    }
    return memory
      .filter((artifact) => inScope(artifact.threadId))
      .map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        type: artifact.type,
        path: artifact.path,
        note: `${artifact.threadTitle} · ${artifact.type}`,
      }))
  }, [kernel, memory, threads, allowed])

  /* 范围里一个都没有、但库里其实有 —— 说清楚是范围的问题，不是成果没了 */
  const total = kernel?.length ?? memory.length
  const emptyByScope = rows.length === 0 && total > 0 && scope !== 'all'

  async function openArtifact(row: Row): Promise<void> {
    if (!row.path) return
    const ok = await fsReveal(row.path)
    setDead((prev) => ({ ...prev, [row.id]: !ok }))
    if (!ok) showToast('error', '打不开这个成果', `${row.path} 已不存在或没有访问权限`)
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-fg-secondary">
        <FileCode2 size={14} />
        <span title="只统计正式产出（artifact），不含工作区里被改动的文件">
          成果 · {rows.length}
        </span>
        <span className="flex-1" />
        {/* 范围切换：只影响显示，不改记录归属 */}
        <div className="flex items-center gap-0.5" role="group" aria-label="成果范围">
          {SCOPES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setScope(item.id)}
              aria-pressed={scope === item.id}
              className={cn(
                'rounded-sm px-1.5 py-0.5 text-2xs transition-colors duration-fast',
                scope === item.id
                  ? 'bg-bg-raised text-fg-primary'
                  : 'text-fg-tertiary hover:bg-bg-hover hover:text-fg-secondary',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {emptyByScope ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center text-2xs text-fg-tertiary">
          <p className="max-w-[20rem] leading-relaxed">
            这个范围里没有成果，但别处还有 {total} 个。
          </p>
          <button
            type="button"
            onClick={() => setScope('all')}
            className="rounded-sm border border-line-subtle px-2 py-1 text-2xs text-fg-secondary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary"
          >
            查看全部 {total} 个成果
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center text-2xs text-fg-tertiary">
          <p className="max-w-[20rem] leading-relaxed">
            「成果」只放正式产出：带文件名的代码块、内核登记的产物。 普通的文件修改不算成果。
          </p>
          {diffCount > 0 ? (
            <button
              type="button"
              onClick={() => setActiveRightTab('diff')}
              className="rounded-sm border border-line-subtle px-2 py-1 text-2xs text-fg-secondary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary"
            >
              去「审查」看本次修改的 {diffCount} 个文件
            </button>
          ) : (
            <p className="max-w-[20rem] leading-relaxed">
              Agent 改过工作区文件的话，去「审查」标签看这次的改动。
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <div key={row.id} className="rounded-sm border border-line-subtle bg-bg-raised/30 p-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-primary">
                  {row.name}
                </span>
                {row.path ? (
                  <button
                    type="button"
                    onClick={() => void openArtifact(row)}
                    className={cn(
                      'transition-colors',
                      dead[row.id] ? 'text-danger' : 'text-fg-tertiary hover:text-fg-primary',
                    )}
                    aria-label={dead[row.id] ? '成果文件已不在原位置' : '打开成果所在位置'}
                    title={dead[row.id] ? `${row.path}（已失效）` : row.path}
                  >
                    <ExternalLink size={13} />
                  </button>
                ) : null}
              </div>
              <p className="mt-1 truncate text-2xs text-fg-tertiary">
                {row.note}
                {row.path ? (
                  <span className={dead[row.id] ? 'text-danger' : ''}>
                    {' · '}
                    {row.path}
                  </span>
                ) : null}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
