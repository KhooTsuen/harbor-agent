import { FolderOpen, Loader2, Plus, RefreshCw, Shield } from 'lucide-react'
import { useState } from 'react'
import { useConfigStore } from '@/stores/useConfigStore'
import { useUIStore } from '@/stores/useUIStore'
import { listProviderModels } from '@/lib/backend'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { ProviderCard } from './providers/ProviderCard'
import { ModelField } from './providers/ModelField'

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
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus size={13} />}
          className="ml-auto shrink-0"
          onClick={() => void add()}
        >
          加一个
        </Button>
      </div>

      {config.providers.map((provider) => (
        <ProviderCard key={provider.id} provider={provider} />
      ))}
    </div>
  )
}

/* ── 助手参数 ─────────────────────────────────────────────── */

export function AssistantPanel() {
  const config = useConfigStore((s) => s.config)
  const patchAssistant = useConfigStore((s) => s.patchAssistant)
  const updateProvider = useConfigStore((s) => s.updateProvider)
  const showToast = useUIStore((s) => s.showToast)
  const [fetching, setFetching] = useState(false)

  if (!config) return null
  /* 取成局部常量：TS 的 null 收窄进不了闭包，fetchModels 里会报 config 可能为 null */
  const providers = config.providers
  const a = config.assistant

  /** 从供应商的 /models 接口拉清单，并合并进那家的模型列表 */
  async function fetchModels(): Promise<void> {
    const owner =
      providers.find((p) => p.models.includes(a.model)) ??
      providers.find((p) => p.enabled) ??
      providers[0]
    if (!owner) {
      showToast('error', '还没有供应商', '先去上面的「供应商」里加一个')
      return
    }

    setFetching(true)
    const result = await listProviderModels(owner.id)
    setFetching(false)

    if (!result.ok || !result.models) {
      showToast('error', '拉取失败', result.error)
      return
    }

    /* 合并而不是覆盖 —— 用户手打的自定义模型名别弄丢了 */
    const merged = [...new Set([...owner.models, ...result.models])]
    await updateProvider(owner.id, { models: merged })
    showToast('success', `拉到 ${result.models.length} 个模型`, `${owner.name} 的清单已更新`)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="block">
          <span className="mb-1 flex items-center gap-2 text-2xs text-fg-tertiary">
            用哪个模型
            <button
              type="button"
              onClick={() => void fetchModels()}
              disabled={fetching}
              title="从供应商的 /models 接口拉取清单"
              className="ml-auto inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 transition-colors hover:bg-bg-hover hover:text-fg-primary disabled:opacity-50"
            >
              {fetching ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              {fetching ? '拉取中' : '获取模型'}
            </button>
          </span>
          <ModelField
            value={a.model}
            onChange={(v) => void patchAssistant({ model: v })}
            providers={providers}
          />
        </div>
        <label className="block">
          <span className="mb-1 block text-2xs text-fg-tertiary">历史轮数（0 = 不带历史）</span>
          <Field
            type="number"
            value={String(a.historyLimit)}
            onChange={(v) => void patchAssistant({ historyLimit: Number(v) || 0 })}
          />
        </label>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <label className="block">
          <span className="mb-1 block text-2xs text-fg-tertiary">temperature</span>
          <Field
            type="number"
            value={String(a.temperature)}
            onChange={(v) => void patchAssistant({ temperature: Number(v) })}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-2xs text-fg-tertiary">max tokens</span>
          <Field
            type="number"
            value={String(a.maxTokens)}
            onChange={(v) => void patchAssistant({ maxTokens: Number(v) || 4096 })}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-2xs text-fg-tertiary">助手名字</span>
          <Field value={a.name} onChange={(v) => void patchAssistant({ name: v })} />
        </label>
        <label className="flex items-center gap-2 text-dense text-fg-primary">
          <input
            type="checkbox"
            checked={a.selfReview}
            onChange={(e) => void patchAssistant({ selfReview: e.target.checked })}
          />
          重要回答自动复核
        </label>
        <label className="block">
          <span className="mb-1 block text-2xs text-fg-tertiary">回答深度</span>
          <select
            value={a.responseDepth}
            onChange={(e) =>
              void patchAssistant({
                responseDepth: e.target.value as typeof a.responseDepth,
              })
            }
            className="w-full rounded-base border border-line-hairline bg-bg-surface px-2.5 py-1.5 text-dense text-fg-primary focus:border-line-focus focus:outline-none"
          >
            <option value="concise">简洁</option>
            <option value="standard">标准</option>
            <option value="detailed">详细</option>
            <option value="deep">深入</option>
          </select>
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-2xs text-fg-tertiary">
          自定义人设（留空用内置的，内置版本会带上环境信息和工具清单）
        </span>
        <textarea
          value={a.systemPrompt}
          onChange={(e) => void patchAssistant({ systemPrompt: e.target.value })}
          rows={5}
          placeholder="留空即可"
          className="w-full resize-y rounded-base border border-line-hairline bg-bg-surface px-2.5 py-2 font-mono text-xs text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
        />
      </label>
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
  { id: 'ask' as const, label: '需要确认', hint: '写文件、改文件、跑命令都会弹窗问你。默认推荐。' },
  {
    id: 'full' as const,
    label: '完全访问',
    hint: '不给任何确认，直接改、直接跑。快，但要有把握时再用。',
  },
]

export function ToolsPanel() {
  const config = useConfigStore((s) => s.config)
  const patchTools = useConfigStore((s) => s.patchTools)
  const workdir = useConfigStore((s) => s.workdir)
  const chooseWorkdir = useConfigStore((s) => s.chooseWorkdir)
  const [picking, setPicking] = useState(false)

  if (!config) return null

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-2 flex items-center gap-1.5 text-2xs text-fg-tertiary">
          <Shield size={12} />
          工具权限
        </p>
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="工具权限">
          {PERMISSIONS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={config.tools.permission === p.id}
              onClick={() => void patchTools({ permission: p.id })}
              className={
                config.tools.permission === p.id
                  ? 'rounded-base border border-line-focus bg-bg-raised px-3 py-2 text-left'
                  : 'rounded-base border border-line-hairline px-3 py-2 text-left transition-colors hover:bg-bg-hover'
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

      <div className="px-3.5 py-3">
        <p className="mb-1 text-2xs text-fg-tertiary">
          工作目录（模型看到的「相对路径」是相对这里）
        </p>
        <div className="flex items-center gap-2">
          <span
            className="min-w-0 flex-1 truncate rounded-base border border-line-hairline bg-bg-raised/30 px-2.5 py-1.5 font-mono text-xs text-fg-secondary"
            title={workdir || config.general.workdir}
          >
            {workdir || config.general.workdir || '（默认：data/workspace）'}
          </span>
          <Button
            size="sm"
            variant="secondary"
            loading={picking}
            icon={<FolderOpen size={13} />}
            onClick={() => {
              setPicking(true)
              void chooseWorkdir().finally(() => setPicking(false))
            }}
          >
            换一个
          </Button>
        </div>
      </div>

      <label className="block px-3.5 py-3">
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
