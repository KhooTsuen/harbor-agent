import { useEffect, useMemo, useState } from 'react'
import { FileCode2, ExternalLink } from 'lucide-react'
import type { Artifact } from '@/types'
import type { ArtifactRecord } from '@/types/models-extra'
import { useAppStore } from '@/stores/useAppStore'
import { useTaskStore } from '@/stores/useTaskStore'
import { useUIStore } from '@/stores/useUIStore'
import { fsReveal } from '@/lib/fsApi'
import { artifactList } from '@/lib/artifactApi'

/* ══════════════════════════════════════════════════════════════
   成果面板

   数据源两层（优先内核，②的「最小接线」）：
     ① 内核 `artifact:list` —— 有版本历史、关掉会话也还在
     ② 前端内存汇总       —— **降级路径**：浏览器预览、或 preload 还没接上时用，
                             行为与以前一模一样（不因为桥没接好就白屏）

   面板只列元信息（名字 / 类型 / 版本 / 路径），正文要用时再按版本去取。
   ══════════════════════════════════════════════════════════════ */

type Row = {
  id: string
  name: string
  type: string
  path?: string
  note: string
}

export function ArtifactsPanel() {
  const threads = useAppStore((s) => s.threads)
  const [kernel, setKernel] = useState<ArtifactRecord[] | null>(null)

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
    const result: Array<Artifact & { threadTitle: string }> = []
    for (const thread of threads) {
      for (const message of thread.messages) {
        for (const artifact of message.artifacts ?? []) {
          if (seen.has(artifact.id)) continue
          seen.add(artifact.id)
          result.push({ ...artifact, threadTitle: thread.title })
        }
      }
    }
    return result
  }, [threads])

  const rows = useMemo<Row[]>(() => {
    if (kernel && kernel.length > 0) {
      return kernel.map((artifact) => {
        const title = threads.find((t) => t.id === artifact.threadId)?.title
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
    return memory.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      type: artifact.type,
      path: artifact.path,
      note: `${artifact.threadTitle} · ${artifact.type}`,
    }))
  }, [kernel, memory, threads])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div
        className="mb-3 flex items-center gap-2 text-xs text-fg-secondary"
        title="只统计正式产出（artifact），不含工作区里被改动的文件"
      >
        <FileCode2 size={14} /> 成果 · {rows.length}
      </div>
      {rows.length === 0 ? (
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
                    onClick={() => void fsReveal(row.path ?? '')}
                    className="text-fg-tertiary hover:text-fg-primary"
                    aria-label="打开成果"
                  >
                    <ExternalLink size={13} />
                  </button>
                ) : null}
              </div>
              <p className="mt-1 truncate text-2xs text-fg-tertiary">{row.note}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
