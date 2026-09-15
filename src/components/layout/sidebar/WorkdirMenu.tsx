import { useEffect, useState } from 'react'
import { Check, ChevronDown, FolderOpen, FolderPlus } from 'lucide-react'
import { listWorkdirs } from '@/lib/backend'
import { useAppStore } from '@/stores/useAppStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useUIStore } from '@/stores/useUIStore'
import { Popover } from '@/components/ui/Popover'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   对话文件夹

   一个「文件夹」= 一个工作目录，底下的对话各归各家。
   切换它会同时做三件事：
     · 换 AI 的操作目录（写进 config，重启还在）
     · 换侧栏的对话列表（会话按 workdir 分组）
     · 换右栏的文件树（RightPanel 挂在 project 上）

   为什么要有这个菜单：用户不该去记「上次那个目录在哪」——
   直接把用过的目录列出来挑就行。
   ══════════════════════════════════════════════════════════════ */

/** 路径只显示最后一段，完整路径挂在 title 上 */
export function folderLabel(workdir: string): string {
  if (!workdir) return '（默认目录）'
  const parts = workdir
    .replace(/[\\/]+/g, '/')
    .split('/')
    .filter(Boolean)
  return parts.pop() ?? workdir
}

interface DirEntry {
  workdir: string
  count: number
}

export function WorkdirMenu() {
  const workdir = useAppStore((s) => s.workdir)
  const setWorkdir = useAppStore((s) => s.setWorkdir)
  const patchGeneral = useConfigStore((s) => s.patchGeneral)
  const chooseWorkdir = useConfigStore((s) => s.chooseWorkdir)
  const showToast = useUIStore((s) => s.showToast)

  const [open, setOpen] = useState(false)
  const [dirs, setDirs] = useState<DirEntry[]>([])

  /* 每次打开都重拉一遍：刚建的对话会改变会话数 */
  useEffect(() => {
    if (!open) return
    void (async () => setDirs(await listWorkdirs()))()
  }, [open])

  async function switchTo(dir: string): Promise<void> {
    setOpen(false)
    if (dir === workdir) return
    /* 两处都要写：config 管持久化，appStore 管当前界面 */
    await patchGeneral({ workdir: dir })
    await setWorkdir(dir)
    showToast('success', '已切换对话文件夹', folderLabel(dir))
  }

  async function pickNew(): Promise<void> {
    setOpen(false)
    const ok = await chooseWorkdir()
    if (ok) showToast('success', '已切换对话文件夹')
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="start"
      className="min-w-0 p-0"
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          data-workdir-trigger="true"
          className="flex w-full items-center gap-2 rounded-small px-2 py-1.5 text-dense text-fg-secondary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          <FolderOpen size={15} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">对话文件夹</span>
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </button>
      )}
    >
      <div className="flex w-72 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto p-1" style={{ maxHeight: '18rem' }}>
          {dirs.length === 0 ? (
            <p className="px-2 py-3 text-center text-2xs text-fg-tertiary">还没有对话</p>
          ) : (
            dirs.map((entry) => {
              const active = entry.workdir === workdir
              return (
                <button
                  key={entry.workdir || '__default__'}
                  type="button"
                  onClick={() => void switchTo(entry.workdir)}
                  title={entry.workdir || '默认目录'}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors duration-fast',
                    active
                      ? 'bg-bg-raised text-fg-primary'
                      : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
                  )}
                >
                  <FolderOpen size={12} className="shrink-0 text-fg-tertiary" />
                  <span className="min-w-0 flex-1 truncate">{folderLabel(entry.workdir)}</span>
                  <span className="shrink-0 font-mono text-2xs text-fg-tertiary">
                    {entry.count}
                  </span>
                  {active ? (
                    <Check size={12} className="shrink-0" style={{ color: 'var(--accent-blue)' }} />
                  ) : null}
                </button>
              )
            })
          )}
        </div>

        <div className="shrink-0 border-t border-line-subtle p-1">
          <button
            type="button"
            onClick={() => void pickNew()}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-fg-secondary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary"
          >
            <FolderPlus size={12} className="shrink-0 text-fg-tertiary" />
            选其他目录…
          </button>
        </div>
      </div>
    </Popover>
  )
}
