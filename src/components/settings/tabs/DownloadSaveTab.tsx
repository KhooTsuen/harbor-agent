import { FolderOpen, RotateCcw } from 'lucide-react'
import { useConfigStore } from '@/stores/useConfigStore'
import { chooseFolder } from '@/lib/backend'
import { Row } from '../parts'
import { Button } from '@/components/ui/Button'

/* ══════════════════════════════════════════════════════════════
   浏览器下载位置

   内置网页里点「下载」时文件存哪。留空 = 当前会话工作目录。
   内核侧：`core/download-intake.cjs` 在网页分区 session 上挂 will-download，
   把公开文件（http/https）接进内置下载队列 —— 这一项就是它的落盘目录。
   ══════════════════════════════════════════════════════════════ */

export function DownloadSaveTab() {
  const config = useConfigStore((s) => s.config)
  const patchDownloads = useConfigStore((s) => s.patchDownloads)
  const dir = String(config?.downloads?.browserDir ?? '').trim()

  async function pick(): Promise<void> {
    const picked = await chooseFolder()
    if (picked.ok && picked.dir) await patchDownloads({ browserDir: picked.dir })
  }

  async function reset(): Promise<void> {
    await patchDownloads({ browserDir: '' })
  }

  return (
    <Row
      label="浏览器下载位置"
      hint="内置网页里点下载时文件存到哪。留空 = 当前会话工作目录。公开文件走内置下载（可续传）；需登录的仍由浏览器自己下。"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-secondary">
          {dir || '（默认：当前会话工作目录）'}
        </span>
        <Button
          size="sm"
          variant="secondary"
          icon={<FolderOpen size={12} />}
          onClick={() => void pick()}
        >
          选择目录
        </Button>
        {dir ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<RotateCcw size={12} />}
            onClick={() => void reset()}
          >
            恢复默认
          </Button>
        ) : null}
      </div>
    </Row>
  )
}
