import { Plug, Plus } from 'lucide-react'
import { useConfigStore } from '@/stores/useConfigStore'
import { Button } from '@/components/ui/Button'
import { ProviderCard } from './providers/ProviderCard'
import { CodexCliCard } from './providers/CodexCliCard'

/* ══════════════════════════════════════════════════════════════
   设置 → 模型 → 供应商

   ★ 第四阶段：`ToolsPanel`（权限档位 / 命令超时）搬去了
     `security/PermissionLevelSummary.tsx` —— 它属于「权限与安全」，
     放在模型页只是历史遗留。这里不再有它的任何副本或转出。
   ══════════════════════════════════════════════════════════════ */

/* ── 供应商 ───────────────────────────────────────────────── */

export function ProviderPanel() {
  const config = useConfigStore((s) => s.config)
  const add = useConfigStore((s) => s.addProvider)
  /* 「加 Codex CLI」：老用户的 providers 数组里没有新预设，得给他们一个入口（见 store 注释） */
  const addCodex = useConfigStore((s) => s.addCodexProvider)

  if (!config) {
    return (
      <p className="py-4 text-dense leading-relaxed text-fg-secondary">
        当前运行在浏览器预览环境。真实模型、文件、终端和配置功能请使用桌面版；启动{' '}
        <span className="font-mono">npm run dev</span> 会打开 Electron 桌面版。
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="text-dense leading-relaxed text-fg-secondary">
          配好 baseUrl 和 API Key 就能真的对话。支持任何 OpenAI 兼容接口。
        </p>
        {config.providers.some((p) => p.kind === 'codex-cli') ? null : (
          <Button
            size="sm"
            variant="secondary"
            icon={<Plug size={13} />}
            className="ml-auto shrink-0"
            onClick={() => void addCodex()}
          >
            添加 Codex CLI
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus size={13} />}
          className={
            config.providers.some((p) => p.kind === 'codex-cli') ? 'ml-auto shrink-0' : 'shrink-0'
          }
          onClick={() => void add()}
        >
          加一个
        </Button>
      </div>

      {config.providers.map((provider) =>
        /* codex-cli 是 CLI 后端：字段与 HTTP 供应商几乎不重叠 —— 单独一张卡（见那个文件头） */
        provider.kind === 'codex-cli' ? (
          <CodexCliCard key={provider.id} provider={provider} />
        ) : (
          <ProviderCard key={provider.id} provider={provider} />
        ),
      )}
    </div>
  )
}
