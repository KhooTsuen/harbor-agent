import { useEffect, useState } from 'react'
import { Check, Copy, Globe, X } from 'lucide-react'
import type { FileNode } from '@/types'
import { extToLanguage, fsRead, fsReveal } from '@/lib/fsApi'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'
import { CodeBlock } from '@/components/chat/CodeBlock'
import { uid } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   文件预览

   桌面版按 node.path 读取真实工作目录；浏览器预览节点可携带静态 content。
   二进制文件不预览（读进来也是乱码）。
   ══════════════════════════════════════════════════════════════ */

export function FilePreview({ node, onClose }: { node: FileNode; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [language, setLanguage] = useState('text')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setError('')

      /* 仅浏览器预览节点可能直接携带 content */
      if (node.content !== undefined) {
        setContent(node.content)
        setLanguage(node.language ?? 'text')
        setLoading(false)
        return
      }

      /* 真实节点：按 path 读磁盘 */
      if (!node.path) {
        setContent('')
        setLoading(false)
        return
      }
      const result = await fsRead(node.path)
      if (result && result.ok) {
        if (result.binary) {
          setError(`二进制文件（${(result.size ?? 0).toLocaleString('zh-CN')} 字节），不预览`)
          setContent(null)
        } else {
          setContent(result.text ?? '')
          setLanguage(extToLanguage(result.ext ?? ''))
        }
      } else {
        setError(result?.error ?? '读文件失败')
        setContent(null)
      }
      setLoading(false)
    })()
  }, [node])

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(content ?? '')
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      /* 忽略 */
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <div className="flex shrink-0 items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-fg-primary"
          title={node.path ?? node.name}
        >
          {node.name}
        </span>
        <Tooltip content={copied ? '已复制' : '复制内容'}>
          <IconButton
            label="复制文件内容"
            size={28}
            disabled={loading || content === null}
            onClick={() => void copy()}
          >
            {copied ? <Check size={14} style={{ color: 'var(--success)' }} /> : <Copy size={14} />}
          </IconButton>
        </Tooltip>
        {node.path ? (
          <Tooltip content="在资源管理器里显示">
            <IconButton
              label="在资源管理器里显示"
              size={28}
              onClick={() => void fsReveal(node.path ?? '')}
            >
              <Globe size={13} />
            </IconButton>
          </Tooltip>
        ) : null}
        <IconButton label="关闭预览" size={28} onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <p className="p-3 text-2xs text-fg-tertiary">读取中…</p>
        ) : error ? (
          <p className="p-3 text-2xs" style={{ color: 'var(--warning)' }}>
            {error}
          </p>
        ) : (
          <CodeBlock
            block={{
              id: uid('cb'),
              language,
              code: content ?? '',
            }}
          />
        )}
      </div>
    </div>
  )
}
