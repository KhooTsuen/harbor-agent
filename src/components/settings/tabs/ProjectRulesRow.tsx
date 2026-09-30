import { useCallback, useEffect, useState } from 'react'
import { FileText, FolderOpen, Plus, RefreshCw } from 'lucide-react'
import { useAppStore } from '@/stores/useAppStore'
import { Button } from '@/components/ui/Button'
import {
  describeRules,
  projectRulesOpen,
  projectRulesReload,
  projectRulesStatus,
} from '@/lib/projectRulesApi'
import type { ProjectRulesStatus } from '@/types/projectRules'
import { colorOf } from '@/lib/statusLanguage'
import { Row } from '../parts'

/* ══════════════════════════════════════════════════════════════
   对话设置 → 项目规则（`<工作目录>/.harbor/rules.md`）

   这一行只说三件事：**文件在哪 / 现在什么状态 / 怎么改**。
   状态措辞统一走 `lib/projectRulesApi.ts` 的 `describeRules()`
   （和真机探针共用一份，免得两处各自漂）。

   改完文件不用重启：文件 mtime 一变，**下次发消息**就会自动重新读；
   想立刻生效就点「重新加载」（它跳过缓存）。
   ══════════════════════════════════════════════════════════════ */

export function ProjectRulesRow() {
  /* 目录口径和右栏一致：会话自己的目录优先，没有才用全局默认 */
  const threadWorkdir = useAppStore(
    (s) => s.threads.find((t) => t.id === s.activeThreadId)?.workdir,
  )
  const globalWorkdir = useAppStore((s) => s.workdir)
  const dir = threadWorkdir || globalWorkdir || ''

  const [status, setStatus] = useState<ProjectRulesStatus | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(() => {
    let alive = true
    void projectRulesStatus(dir).then((next) => {
      if (alive) setStatus(next)
    })
    return () => {
      alive = false
    }
  }, [dir])

  useEffect(() => refresh(), [refresh])

  async function reload(): Promise<void> {
    setBusy('reload')
    setNotice('')
    setStatus(await projectRulesReload(dir))
    setBusy('')
  }

  async function open(create: boolean): Promise<void> {
    setBusy(create ? 'create' : 'open')
    setNotice('')
    const result = await projectRulesOpen(dir, create)
    if (result?.ok) refresh()
    else setNotice(result?.error || '打不开这个文件')
    setBusy('')
  }

  const said = describeRules(status)
  const tone =
    said.tone === 'ok'
      ? colorOf('completed')
      : said.tone === 'warn'
        ? colorOf('warning')
        : undefined

  return (
    <Row label="项目规则" hint={notice ? `${said.hint} · ${notice}` : said.hint}>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-xs text-fg-secondary">
          <FileText size={13} className="shrink-0" />
          <span className="truncate" title={status?.file || ''}>
            {status?.file || `${dir ? `${dir}\\.harbor` : '.harbor'}\\rules.md`}
          </span>
        </div>
        <div className="text-dense" style={tone ? { color: tone } : undefined}>
          {said.text}
        </div>
        <div className="flex justify-end gap-2">
          {status && !status.exists ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus size={13} />}
              loading={busy === 'create'}
              onClick={() => void open(true)}
            >
              创建
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            icon={<FolderOpen size={13} />}
            loading={busy === 'open'}
            onClick={() => void open(false)}
          >
            打开文件
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={13} />}
            loading={busy === 'reload'}
            onClick={() => void reload()}
          >
            重新加载
          </Button>
        </div>
      </div>
    </Row>
  )
}
