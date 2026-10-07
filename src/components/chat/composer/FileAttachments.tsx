import {
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Presentation,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { AttachedFile } from '@/types/backend-io'
import { IconButton } from '@/components/ui/IconButton'
import { formatSize } from '@/stores/thread/attachments'
import { useThreadStore } from '@/stores/useThreadStore'

/* ══════════════════════════════════════════════════════════════
   待发送文件的预览条（图片另有 ImageAttachments）

   贴在输入框上方。每个附件一张小卡片：类型图标 + 文件名 + 一句详情。
   正文留在 store 里，**发送时才拼进消息**（见 thread/attachments.ts）。

   抽成组件是因为 Composer 贴着 300 行 —— 它只管「什么时候加附件」，
   不管「附件长什么样」。
   ══════════════════════════════════════════════════════════════ */

const ICONS: Record<string, LucideIcon> = {
  text: FileText,
  pdf: FileText,
  docx: FileText,
  xlsx: FileSpreadsheet,
  pptx: Presentation,
  archive: FileArchive,
  image: FileImage,
  binary: FileText,
}

/** 卡片第二行右边那句「多大 / 多少内容」 */
function detailOf(file: AttachedFile): string {
  if (file.kind === 'archive') return `${file.entryCount ?? 0} 个条目`
  if (file.kind === 'binary') return '二进制 · 未读内容'
  if (file.pages) return `${file.pages} 页`
  if (file.sheets) return `${file.sheets} 张表`
  if (file.slides) return `${file.slides} 张`
  if (file.text) return `${file.text.length} 字${file.truncated ? '（已截断）' : ''}`
  return ''
}

export function FileAttachments() {
  const files = useThreadStore((s) => s.inputFiles)
  const remove = useThreadStore((s) => s.removeInputFile)

  if (files.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2 px-1 pb-1.5">
      {files.map((file, index) => {
        const Icon = ICONS[file.kind ?? 'binary'] ?? FileText
        return (
          <div
            key={`${file.path ?? file.name}-${index}`}
            className="flex items-center gap-2 rounded-base border border-line-hairline px-2 py-1"
          >
            <Icon size={14} className="shrink-0 text-fg-tertiary" />
            <div className="flex min-w-0 flex-col">
              <span className="max-w-[16rem] truncate text-xs text-fg-primary">{file.name}</span>
              <span className="text-2xs text-fg-tertiary">
                {file.label ?? '文件'}
                {file.size ? ` · ${formatSize(file.size)}` : ''}
                {detailOf(file) ? ` · ${detailOf(file)}` : ''}
              </span>
            </div>
            <IconButton label={`移除 ${file.name}`} size={28} onClick={() => remove(index)}>
              <X size={12} />
            </IconButton>
          </div>
        )
      })}
    </div>
  )
}
