import { Plug, Plus, Shield } from 'lucide-react'
import { useConfigStore } from '@/stores/useConfigStore'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { ProviderCard } from './providers/ProviderCard'
import { CodexCliCard } from './providers/CodexCliCard'

/* ══════════════════════════════════════════════════════════════
   设置 → 模型 / 工具

   拆成三个导出，各自独立：
     ProviderPanel   供应商列表
     AssistantPanel  助手参数（模型 / 采样 / 人设）
     ToolsPanel      权限档位 / 工作目录 / 超时
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

/* ── 工具与权限 ───────────────────────────────────────────── */

const PERMISSIONS = [
  {
    id: 'readonly' as const,
    label: '只读',
    hint: '只能看文件，不能改。让它先调研、你自己动手时用。',
  },
  {
    id: 'ask' as const,
    label: '需要确认',
    hint: '写文件、改文件、跑命令（含低风险）都会弹窗问你。默认推荐。',
  },
  {
    id: 'full' as const,
    label: '完全访问',
    hint: '不再弹任何确认框：写文件、跑命令（含高风险）、工作目录之外的文件都直接执行。要拦住某类命令，去「权限与安全 → Shell 风险策略」把它设成「拦住」；注意那边设成「每次先问」在这一档下不会生效（设了也不问）。',
  },
]

export function ToolsPanel() {
  const config = useConfigStore((s) => s.config)
  const patchTools = useConfigStore((s) => s.patchTools)
  if (!config) return null

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-2 flex items-center gap-1.5 text-2xs text-fg-tertiary">
          <Shield size={12} />
          工具权限
        </p>
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="工具权限">
          {PERMISSIONS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={config.tools.permission === p.id}
              onClick={() => void patchTools({ permission: p.id })}
              className={
                config.tools.permission === p.id
                  ? 'acrylic-card text-left'
                  : 'acrylic-card text-left transition-colors hover:bg-bg-hover'
              }
            >
              <span className="flex items-center gap-2 text-dense text-fg-primary">
                {p.label}
                {config.tools.permission === p.id ? (
                  <span className="text-2xs text-fg-secondary">●</span>
                ) : null}
              </span>
              <span className="mt-0.5 block text-2xs leading-relaxed text-fg-tertiary">
                {p.hint}
              </span>
            </button>
          ))}
        </div>
      </div>

      <label className="acrylic-card block">
        <span className="mb-1 block text-2xs text-fg-tertiary">命令超时（秒）</span>
        <Field
          type="number"
          value={String(config.tools.shellTimeout)}
          onChange={(v) => void patchTools({ shellTimeout: Number(v) || 60 })}
        />
      </label>
    </div>
  )
}
