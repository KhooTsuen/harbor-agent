import { useMemo } from 'react'
import { FileCode2, ExternalLink } from 'lucide-react'
import type { Artifact } from '@/types'
import { useAppStore } from '@/stores/useAppStore'
import { fsReveal } from '@/lib/fsApi'

export function ArtifactsPanel() {
  const threads = useAppStore((s) => s.threads)
  const artifacts = useMemo(() => {
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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mb-3 flex items-center gap-2 text-xs text-fg-secondary">
        <FileCode2 size={14} /> 成果 · {artifacts.length}
      </div>
      {artifacts.length === 0 ? (
        <p className="py-8 text-center text-2xs text-fg-tertiary">
          完成带文件名的代码块后，成果会出现在这里。
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {artifacts.map((artifact) => (
            <div
              key={artifact.id}
              className="rounded-sm border border-line-subtle bg-bg-raised/30 p-2"
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-primary">
                  {artifact.name}
                </span>
                {artifact.path ? (
                  <button
                    type="button"
                    onClick={() => void fsReveal(artifact.path ?? '')}
                    className="text-fg-tertiary hover:text-fg-primary"
                    aria-label="打开成果"
                  >
                    <ExternalLink size={13} />
                  </button>
                ) : null}
              </div>
              <p className="mt-1 truncate text-2xs text-fg-tertiary">
                {artifact.threadTitle} · {artifact.type}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
