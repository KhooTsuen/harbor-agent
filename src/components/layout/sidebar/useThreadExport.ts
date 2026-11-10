import { useEffect, useRef, useState } from 'react'
import type { Thread } from '@/types'
import { saveText } from '@/lib/backend'
import { threadToMarkdown } from '@/lib/export'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import '@/styles/conversation-answer.css'

export function useThreadExport(thread: Thread, closeMenu: () => void) {
  const markExported = useAppStore((state) => state.markThreadExported)
  const showToast = useUIStore((state) => state.showToast)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)
  const timer = useRef<number>()
  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function exportThread(): Promise<void> {
    closeMenu()
    window.clearTimeout(timer.current)
    setFailed(false)
    setFeedback('正在导出')
    try {
      const result = await saveText(`${thread.title}.md`, threadToMarkdown(thread))
      if (result.ok) {
        markExported(thread.id)
        setFeedback('已导出')
        showToast('success', '已导出', result.path ?? 'Markdown')
        timer.current = window.setTimeout(() => setFeedback(''), 1800)
      } else if (result.canceled) {
        setFeedback('')
      } else {
        setFailed(true)
        setFeedback(`导出失败：${result.error ?? '文件未能保存'}`)
        showToast('error', '导出失败', result.error)
      }
    } catch (error) {
      setFailed(true)
      setFeedback(`导出失败：${error instanceof Error ? error.message : '文件未能保存'}`)
    }
  }

  return { feedback, failed, exportThread }
}
