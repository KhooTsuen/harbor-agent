import { useState } from 'react'
import type { TestStatusInfo } from '@/types/safety'
import type { WorkspaceSummary as WorkspaceSummaryData } from '@/types/workspace'
import { formatUpdated } from '@/components/chat/taskCenterModel'

/* ══════════════════════════════════════════════════════════════
   开屏「状态层」：工作区摘要（设计文档 §6.2 / §10）

   最多两行：名字+路径缩略 / 技术栈·Git·测试。
   规则：
     · 扫描期间显示**中性加载**（不提前给结论）；
     · 每一项失败各自降级（git 不可用就不显示 git 那一段）；
     · 默认不展示完整绝对路径，点一下才展开（§18）。
   ══════════════════════════════════════════════════════════════ */

function testLine(status: TestStatusInfo | null): string {
  if (!status || !status.found || status.tests === 'none') return '测试：未运行'
  if (status.tests === 'passed') return `测试：最近通过（${formatUpdated(status.at ?? 0)}）`
  if (status.tests === 'failed') return `测试：最近一次未通过（${formatUpdated(status.at ?? 0)}）`
  return '测试：最近一次读不出结果'
}

export function WorkspaceSummary({
  scan,
  loading,
  testStatus,
}: {
  scan: WorkspaceSummaryData | null
  loading: boolean
  testStatus: TestStatusInfo | null
}) {
  const [fullPath, setFullPath] = useState(false)

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-1.5 text-dense text-fg-tertiary">
        <span>正在读取工作区信息…</span>
      </div>
    )
  }

  if (!scan || !scan.ok) {
    return (
      <div className="flex flex-col items-center gap-1.5 text-dense text-fg-tertiary">
        <span>无法读取工作区信息{scan?.error ? `（${scan.error}）` : ''}</span>
      </div>
    )
  }

  const stack = scan.stack ?? []
  const git = scan.git
  const gitLine = git?.ok
    ? `${git.branch} · ${git.changes === 0 ? '工作区干净' : `${git.changes} 个变更`}`
    : '不是 Git 仓库'

  return (
    <div className="flex flex-col items-center gap-1 text-dense">
      <button
        type="button"
        onClick={() => setFullPath((v) => !v)}
        title="点击展开/收起完整路径"
        className="max-w-[68ch] truncate rounded-sm px-1 text-fg-primary transition-colors duration-fast hover:bg-bg-hover"
      >
        {scan.name}
        <span className="ml-1.5 text-2xs text-fg-tertiary">
          {fullPath ? scan.dir : `…${scan.dir.slice(-24)}`}
        </span>
      </button>
      <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-2xs text-fg-secondary">
        {stack.length > 0 ? <span>{stack.join(' · ')}</span> : <span>空工作区</span>}
        <span aria-hidden="true" className="text-fg-tertiary">
          ·
        </span>
        <span>{gitLine}</span>
        <span aria-hidden="true" className="text-fg-tertiary">
          ·
        </span>
        <span>{testLine(testStatus)}</span>
      </div>
    </div>
  )
}
