import { useCallback, useEffect, useRef, useState } from 'react'
import type { Artifact, Message } from '@/types'
import type { FileProbe } from '@/types/deliverables'
import { fsProbe, fsReveal } from '@/lib/fsApi'
import { useAppStore } from '@/stores/useAppStore'
import { useAnswerMotion } from './AnswerSurface'

export function ArtifactCard({ artifact, message }: { artifact: Artifact; message: Message }) {
  const root = useAppStore((state) => {
    const thread = state.threads.find((item) => item.id === message.threadId)
    return thread?.workdir || state.projects.find((item) => item.id === thread?.projectId)?.path
  })
  const [result, setResult] = useState<FileProbe | null>(null)
  const generation = useRef(0)
  const live = useAnswerMotion()
  const available = result?.ok && result.exists && result.file
  const verify = useCallback(async () => {
    const current = ++generation.current
    const next = artifact.path
      ? await fsProbe(artifact.path, root)
      : { ok: false, error: '未提供本地文件路径' }
    if (current === generation.current) setResult(next)
    return { next, current }
  }, [artifact.path, root])
  useEffect(() => {
    setResult(null)
    void verify()
    const refresh = () => {
      void verify()
    }
    window.addEventListener('focus', refresh)
    return () => {
      generation.current++
      window.removeEventListener('focus', refresh)
    }
  }, [verify])

  async function open() {
    const { next, current } = await verify()
    if (current !== generation.current || !next.ok || !next.exists || !next.file || !artifact.path)
      return
    const opened = await fsReveal(artifact.path, root)
    if (!opened && current === generation.current)
      setResult({ ok: false, error: '未能打开文件，请重新核验' })
  }
  const note =
    !artifact.path && artifact.content
      ? '内容保存在此成果中'
      : !result
        ? '正在核验文件…'
        : !result.ok
          ? result.error
          : !result.exists
            ? '文件不存在或已被移走'
            : !result.file
              ? '此路径不是文件'
              : '文件可用'
  return (
    <div
      data-live-arrival={live && available ? 'true' : undefined}
      className="rounded-sm border border-line-subtle bg-bg-base/30 px-2.5 py-2 text-2xs"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-fg-secondary" title={artifact.path}>
          {artifact.name}
        </span>
        <span className="text-fg-tertiary">成果 · {artifact.type}</span>
        {available ? (
          <button
            type="button"
            onClick={() => void open()}
            className="shrink-0 text-fg-secondary hover:underline"
          >
            打开
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-fg-tertiary" role="status">
        {note}
      </p>
      {artifact.path && result && !available ? (
        <button
          type="button"
          className="mt-1 text-fg-secondary hover:underline"
          onClick={() => void verify()}
        >
          重新核验
        </button>
      ) : null}
    </div>
  )
}
