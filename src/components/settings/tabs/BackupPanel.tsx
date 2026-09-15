import { useEffect, useState } from 'react'
import { FolderOpen, HardDriveDownload, RotateCcw, Trash2 } from 'lucide-react'
import type { BackupInfo } from '@/types/backend'
import { backupCreate, backupList, backupOpen, backupRemove, backupRestore } from '@/lib/extrasApi'
import { useUIStore } from '@/stores/useUIStore'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Row } from '../parts'

/* ══════════════════════════════════════════════════════════════
   备份（放在「数据」页里）

   启动时每天自动备一份。恢复到某一份之前会先自动存一份「恢复前的状态」，
   因为恢复是不可逆的覆盖。
   ══════════════════════════════════════════════════════════════ */

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const p = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const REASON_LABEL: Record<string, string> = {
  auto: '自动',
  manual: '手动',
  'before-restore': '恢复前',
}

export function BackupPanel() {
  const [items, setItems] = useState<BackupInfo[]>([])
  const [busy, setBusy] = useState(false)

  const askPermission = useUIStore((s) => s.askPermission)
  const showToast = useUIStore((s) => s.showToast)

  async function refresh(): Promise<void> {
    setItems(await backupList())
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function create(): Promise<void> {
    setBusy(true)
    const result = await backupCreate()
    setBusy(false)
    if (result.ok) {
      await refresh()
      showToast('success', '已备份', result.name)
    } else {
      showToast('error', '备份失败', result.error)
    }
  }

  return (
    <>
      <Row label="立即备份" hint="配置、记忆、对话、技能。每 24 小时自动一次，最多留 10 份">
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<HardDriveDownload size={13} />}
            loading={busy}
            onClick={() => void create()}
          >
            备份
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<FolderOpen size={13} />}
            onClick={() =>
              void (async () => {
                const r = await backupOpen()
                if (!r.ok) showToast('error', '打不开目录', r.error)
              })()
            }
          >
            打开目录
          </Button>
        </div>
      </Row>

      {items.length > 0 ? (
        <div className="py-2">
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li
                key={item.name}
                className="flex items-center gap-2 rounded-base border border-line-hairline bg-bg-raised/30 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-2xs text-fg-primary">
                      {formatTime(item.createdAt)}
                    </span>
                    <span className="rounded-sm bg-bg-surface px-1.5 py-0.5 text-2xs text-fg-tertiary">
                      {REASON_LABEL[item.reason] ?? item.reason}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-2xs text-fg-tertiary">
                    {formatSize(item.size)}
                    {item.items.length > 0 ? ` · ${item.items.join(', ')}` : ''}
                  </p>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  icon={<RotateCcw size={12} />}
                  onClick={() =>
                    askPermission({
                      kind: 'clear-data',
                      title: `恢复到 ${formatTime(item.createdAt)}？`,
                      description:
                        '当前的配置、记忆、对话和技能都会被这份备份覆盖。恢复前会自动存一份「恢复前状态」，但那也要你手动再恢复一次。恢复之后需要重启软件。',
                      confirmText: '恢复',
                      danger: true,
                      onConfirm: () => {
                        void (async () => {
                          const result = await backupRestore(item.name)
                          if (result.ok) {
                            showToast('success', '已恢复', '请重启软件让改动全部生效')
                            await refresh()
                          } else {
                            showToast('error', '恢复失败', result.error)
                          }
                        })()
                      },
                    })
                  }
                >
                  恢复
                </Button>

                <IconButton
                  label="删除这份备份"
                  size={28}
                  onClick={() =>
                    void (async () => {
                      const r = await backupRemove(item.name)
                      if (r.ok) {
                        await refresh()
                        showToast('success', '已删除')
                      } else {
                        showToast('error', '删除失败', r.error)
                      }
                    })()
                  }
                >
                  <Trash2 size={13} />
                </IconButton>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="py-3 text-2xs leading-relaxed text-fg-tertiary">
          还没有备份。下一次启动软件时会自动存一份。
        </p>
      )}
    </>
  )
}
