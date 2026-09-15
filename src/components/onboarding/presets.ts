/* ══════════════════════════════════════════════════════════════
   常见供应商的预填值

   选一个能省掉三行手填。选「自定义」就全手填 —— 国内中转特别多，
   写死几家不如让人自己填。
   ══════════════════════════════════════════════════════════════ */

export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  model: string
}

export const PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  {
    id: 'moonshot',
    name: 'Moonshot（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
  },
  { id: 'custom', name: '自定义（兼容 OpenAI 的中转）', baseUrl: '', model: '' },
]

export const DEFAULT_PRESET = PRESETS[0]
