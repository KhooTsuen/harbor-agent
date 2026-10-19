import type { AppConfig } from '@/types/backend'
import type { Thread } from '@/types'

function providerIssue(config: AppConfig, providerId: string, model?: string): string | null {
  const provider = config.providers.find((item) => item.id === providerId)
  if (!provider) return '所选模型的连接已删除，请重新选择模型'
  if (!provider.enabled) return `${provider.name} 尚未启用`
  if (provider.kind !== 'codex-cli' && !provider.hasKey) return `${provider.name} 尚未配置 API Key`
  if (model && !provider.models.includes(model)) return `${provider.name} 不再提供所选模型`
  return null
}

export function connectionIssue(
  config: AppConfig | null,
  model: string,
  collab: Thread['collab'] | null,
): string | null {
  if (!config) return '连接配置尚未载入，请打开模型设置检查'
  if (collab) {
    for (const role of [collab.planner, collab.executor]) {
      if (!role) continue
      if (!role.providerId) return '协作模型尚未选好连接'
      const issue = providerIssue(config, role.providerId, role.model)
      if (issue) return issue
    }
    return null
  }
  if (!model) return '尚未选择模型'
  const matching = config.providers.filter((item) => item.models.includes(model))
  const ready = matching.find((item) => item.enabled && (item.kind === 'codex-cli' || item.hasKey))
  if (ready) return null
  const provider = matching[0]
  return provider ? providerIssue(config, provider.id, model) : '所选模型没有可用连接'
}
