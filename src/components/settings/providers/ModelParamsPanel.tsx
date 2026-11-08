import { Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useConfigStore } from '@/stores/useConfigStore'
import { useUIStore } from '@/stores/useUIStore'
import { listProviderModels } from '@/lib/backend'
import { Field } from '@/components/ui/Field'
import { Row, SectionTitle } from '../parts'
import { ModelField } from './ModelField'

/* ══════════════════════════════════════════════════════════════
    模型参数 —— 用哪个模型、输出多长、多随机、带几轮历史

    ── 第三阶段：从 `ProviderPanel.AssistantPanel` 拆出来 ──────────
    原来「模型参数」和「助手人设（名字 / 回答深度 / 自定义人设）」混在
    同一个网格里，用户分不清哪个改的是模型、哪个改的是它怎么说话。
    按真实归属拆开：

      · 这里（模型与场景）    model / historyLimit / temperature / maxTokens
      · `AssistantPersona`    name / responseDepth / systemPrompt

    ★ 配置键与默认值一个没动，只是把编辑位置分开。
    ══════════════════════════════════════════════════════════════ */

export function ModelParamsPanel(): React.ReactElement | null {
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
      showToast('error', '还没有供应商', '先去「服务商」标签里加一个')
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
    <>
      <SectionTitle hint="默认由你手动选；下面「场景模型」可以给特定用途单独指定">
        当前使用
      </SectionTitle>

      <Row label="用哪个模型" hint="这是默认聊天模型。下面「场景模型」里留空的场景都用它。">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <ModelField
              value={a.model}
              onChange={(v) => void patchAssistant({ model: v })}
              providers={providers}
            />
          </div>
          <button
            type="button"
            onClick={() => void fetchModels()}
            disabled={fetching}
            title="从供应商的 /models 接口拉取清单"
            className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary disabled:opacity-50"
          >
            {fetching ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            {fetching ? '拉取中' : '获取模型'}
          </button>
        </div>
      </Row>

      <SectionTitle hint="这三项对所有模型调用生效，场景模型也照这个走">采样参数</SectionTitle>

      <Row label="temperature" hint="越高回答越随机，越低越稳定。多数任务 0.7 就够。">
        <Field
          type="number"
          value={String(a.temperature)}
          onChange={(v) => void patchAssistant({ temperature: Number(v) })}
        />
      </Row>

      <Row
        label="输出上限"
        hint="0 = 不限：不自己设上限，由服务商决定能写多长（推荐，免得长总结被砍断）。"
      >
        <Field
          type="number"
          value={String(a.maxTokens)}
          onChange={(v) =>
            void patchAssistant({ maxTokens: Math.max(0, Math.round(Number(v) || 0)) })
          }
        />
      </Row>

      <Row label="历史轮数" hint="0 = 不带历史。带上几轮取决于模型窗口有多大。">
        <Field
          type="number"
          value={String(a.historyLimit)}
          onChange={(v) => void patchAssistant({ historyLimit: Number(v) || 0 })}
        />
      </Row>
    </>
  )
}
