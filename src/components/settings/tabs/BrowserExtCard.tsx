import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, FolderOpen, Puzzle, RefreshCw } from 'lucide-react'
import type { EdgeInstallStatus } from '@/types/ext'
import { Button } from '@/components/ui/Button'
import { colorOf } from '@/lib/statusLanguage'
import { Row, SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
   扩展设置 → 浏览器插件（Edge 侧边栏）

   ── 这一页能做和不能做的（照着写，别把没做的说成做了）──────────
   做：把扩展产物装到 `<数据目录>\edge-ext\sidepanel`、写启动宿主清单、
       写 HKCU 注册表（不需要管理员）、然后自动打开 edge://extensions。
   不做：替用户在 Edge 里点「加载解压缩的扩展」。Edge 不给扩展「自动加载本地
       目录」的接口，而静默安装（ExtensionInstallForcelist）被微软限死成「未加入
       AD 域时只能装加载项商店里的扩展」。所以**最后两下必须人点**。

   ── 「装好了」怎么判断 ────────────────────────────────────────
   只看 `connected`：扩展真的经命名管道连上主进程了。文件齐、注册表对，但 Edge
   里还没加载扩展时它仍然是 false —— 那时候界面不能显示已安装。
   （判据在主进程 `core/edge-install.cjs` 的 status()，这里不重算。）
   ══════════════════════════════════════════════════════════════ */

/** 状态 → 一句话。措辞按「用户现在该做什么」写，不按「哪一步失败」写 */
function describe(s: EdgeInstallStatus | null): { text: string; tone: 'ok' | 'warn' | 'idle' } {
  if (!s) return { text: '正在读状态…', tone: 'idle' }
  if (s.connected) return { text: '已连接：Edge 里的侧边栏正在使用这个 Harbor', tone: 'ok' }
  if (!s.sourceOk) return { text: '这个版本没带扩展产物，装不了（打包漏了）', tone: 'warn' }
  if (!s.hostOk || !s.registered || !s.staged) {
    return { text: '还没装：点下面的「安装插件」，几秒钟就好', tone: 'idle' }
  }
  return { text: '已写好配置，等你在 Edge 里加载扩展（下面三步）', tone: 'warn' }
}

export function BrowserExtCard() {
  const [status, setStatus] = useState<EdgeInstallStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const refresh = useCallback(() => {
    void window.workbench?.extStatus?.().then((next) => next && setStatus(next))
  }, [])

  useEffect(() => {
    refresh()
    /* 10 秒轮询一次：扩展连上来是 Edge 那边发生的事，主进程不推事件（推一次不值当开一条通道） */
    const timer = setInterval(refresh, 10000)
    return () => clearInterval(timer)
  }, [refresh])

  async function install(): Promise<void> {
    setBusy(true)
    setNotice('')
    try {
      const result = await window.workbench?.extInstall?.()
      if (result) setStatus(result)
      setNotice(
        result?.ok
          ? result.opened
            ? '配置写好了。Edge 已打开扩展页，按下面三步点两下就行。'
            : '配置写好了。手动打开 edge://extensions，按下面三步点两下。'
          : result?.error || '安装没成功',
      )
    } finally {
      setBusy(false)
    }
  }

  const said = describe(status)
  /* 颜色一律问状态语言表（AG-031：组件里不许自己写 var(--success) 这类） */
  const tone =
    said.tone === 'ok'
      ? colorOf('completed')
      : said.tone === 'warn'
        ? colorOf('warning')
        : undefined

  return (
    <>
      <SectionTitle hint="Edge 侧边栏，用它让助手读你正在看的网页">浏览器插件</SectionTitle>

      <Row label="安装到 Edge" hint="写入本机配置，不需要管理员权限">
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Puzzle size={13} />}
              loading={busy}
              disabled={status ? !status.sourceOk : false}
              onClick={() => void install()}
            >
              {status?.hostOk && status?.registered ? '重新安装' : '安装插件'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={13} />}
              onClick={refresh}
              aria-label="刷新插件状态"
            />
          </div>
          <span className="text-dense" style={tone ? { color: tone } : undefined}>
            {said.text}
          </span>
        </div>
      </Row>

      {/* 这三步是 Edge 逼出来的，不是偷懒 —— 说清为什么，用户才不会觉得「没装上」 */}
      {status?.hostOk && status?.registered && !status.connected ? (
        <div className="acrylic-card flex flex-col gap-1.5 text-dense text-fg-secondary">
          <p className="text-meta text-fg-primary">在 Edge 里只差这三下</p>
          <ol className="flex flex-col gap-1 pl-4" style={{ listStyle: 'decimal' }}>
            <li>地址栏打开 edge://extensions，打开「开发人员模式」</li>
            <li>点「加载解压缩的扩展」，选下面这个目录</li>
            <li>回到这里，看到「已连接」就成了</li>
          </ol>
          <div className="flex items-center gap-2 text-xs">
            <FolderOpen size={13} className="shrink-0" />
            <span className="select-all break-all text-fg-tertiary">{status.targetDir}</span>
          </div>
          <p className="text-fg-tertiary">
            扩展 ID 已固定为 <span className="select-all">{status.extensionId}</span>
            ，以后挪目录、重装都不用再改配置。
          </p>
          <p className="text-fg-tertiary">
            为什么不能全自动：Edge
            不提供「自动加载本地目录」的接口；静默安装只允许加载项商店里的扩展。
          </p>
        </div>
      ) : null}

      {notice ? (
        <p className="flex items-center gap-1.5 text-dense text-fg-tertiary">
          <CheckCircle2 size={13} className="shrink-0" />
          {notice}
        </p>
      ) : null}
    </>
  )
}
