import { useConfigStore } from '@/stores/useConfigStore'
import { Row } from '../parts'

/* ══════════════════════════════════════════════════════════════
    上下文压缩阈值（提示 / 自动两档）

    ── 第三阶段：从「模型与场景」的旧 ScenesTab 末尾搬过来 ────────
    它改的是 `config.context.compactAt / autoCompactAt` —— 上下文
    预算的事，跟「用哪个模型」无关。留在模型页会让人以为调的是模型参数。

    ★ 只搬界面位置，配置键、默认值（40% / 60%）、内核判据一概没动。
    ══════════════════════════════════════════════════════════════ */

export function CompactThresholdRow(): React.ReactElement {
  const config = useConfigStore((s) => s.config)
  const patchContext = useConfigStore((s) => s.patchContext)

  return (
    <Row
      label="压缩阈值"
      hint="用到上下文窗口的多少比例时压缩。到「提示」会提醒你手动 /compact；到「自动」会后台压一次，不打断当前对话。"
    >
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-2xs text-fg-secondary">
          提示
          <input
            type="number"
            min={10}
            max={90}
            value={Math.round((config?.context?.compactAt ?? 0.4) * 100)}
            onChange={(e) => void patchContext({ compactAt: (Number(e.target.value) || 40) / 100 })}
            aria-label="压缩提示阈值（百分比）"
            className="w-16 rounded-sm border border-line-subtle bg-bg-raised px-1.5 py-0.5 font-mono text-2xs text-fg-primary focus:outline-none"
          />
          %
        </label>
        <label className="flex items-center gap-1.5 text-2xs text-fg-secondary">
          自动
          <input
            type="number"
            min={20}
            max={95}
            value={Math.round((config?.context?.autoCompactAt ?? 0.6) * 100)}
            onChange={(e) =>
              void patchContext({ autoCompactAt: (Number(e.target.value) || 60) / 100 })
            }
            aria-label="自动压缩阈值（百分比）"
            className="w-16 rounded-sm border border-line-subtle bg-bg-raised px-1.5 py-0.5 font-mono text-2xs text-fg-primary focus:outline-none"
          />
          %
        </label>
      </div>
    </Row>
  )
}
