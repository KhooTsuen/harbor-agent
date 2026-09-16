import { FolderOpen, RotateCcw } from 'lucide-react'
import { useConfigStore } from '@/stores/useConfigStore'
import { chooseFolder } from '@/lib/backend'
import { Row } from '../parts'
import { Button } from '@/components/ui/Button'

/* ══════════════════════════════════════════════════════════════
   生图保存位置

   默认：工作目录下的 generated/。
   用户想存别处（比如 D:\\图库）就在这里改 —— 填了之后生图
   落盘到那个目录，不再往工作目录里塞。
   ══════════════════════════════════════════════════════════════ */

export function ImageSaveTab() {
  const config = useConfigStore((s) => s.config)
  const patchImage = useConfigStore((s) => s.patchImage)
  const dir = String(config?.image?.dir ?? '').trim()

  async function pick(): Promise<void> {
    const picked = await chooseFolder()
    if (picked.ok && picked.dir) {
      await patchImage({ dir: picked.dir })
    }
  }

  async function reset(): Promise<void> {
    await patchImage({ dir: '' })
  }

  return (
    <Row label="生图保存位置" hint="生成好的图片存到哪。留空 = 当前工作目录的 generated/ 子目录">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-secondary">
          {dir || '（默认：工作目录/generated/）'}
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
