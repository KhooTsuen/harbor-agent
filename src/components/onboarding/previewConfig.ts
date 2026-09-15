import type { AppConfig } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   引导页的占位配置

   浏览器（mock 模式）里 useConfigStore.config 永远是 null，而引导页要读它渲染。
   带上 ?onboarding=1 调试开关时用这一份顶上 —— 只看界面，不会真的存东西。
   ══════════════════════════════════════════════════════════════ */

export const PREVIEW_CONFIG: AppConfig = {
  updatedAt: 0,
  version: 1,
  general: {
    theme: 'default',
    glassmorphism: false,
    animations: true,
    fontScale: 100,
    sendOnEnter: true,
    workdir: '',
    onboarded: false,
    onboardingDismissed: false,
    autoTitle: true,
    minimizeToTray: true,
  },
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      chatPath: '/chat/completions',
      models: ['deepseek-chat'],
      enabled: true,
      hasKey: false,
    },
  ],
  assistant: {
    name: 'Agent',
    systemPrompt: '',
    model: 'deepseek-chat',
    temperature: 0.7,
    topP: 1,
    maxTokens: 4096,
    historyLimit: 20,
    responseDepth: 'standard',
    selfReview: false,
    streamOutput: true,
  },
  tools: {
    permission: 'ask',
    shellTimeout: 60,
    fileScope: 'workspace',
    shellPolicy: { medium: 'ask', high: 'ask', critical: 'block' },
    outputLimit: 2 * 1024 * 1024,
  },
  memory: { autoWrite: 'ask', injectLimit: 12, maxItems: 800, retrieve: true },
  context: {
    budget: {
      system: 10,
      memory: 5,
      project: 15,
      task: 10,
      conversation: 30,
      tools: 20,
      reserve: 10,
    },
    compactAt: 0.4,
    autoCompactAt: 0.6,
  },
  router: { enabled: false, roles: { fast: '', reasoning: '', coding: '', vision: '', cheap: '' } },
  fallback: { enabled: true, attempts: 2, retryOn: ['timeout', 'rate_limit', 'server', 'network'] },
  audit: { enabled: true, retentionDays: 30 },
  scenes: {
    chat: { providerId: '', model: '' },
    title: { providerId: '', model: '' },
    prompt: { providerId: '', model: '' },
    translate: { providerId: '', model: '' },
    suggest: { providerId: '', model: '' },
    compact: { providerId: '', model: '' },
    ocr: { providerId: '', model: '' },
    image: { providerId: '', model: '' },
  },
  mcp: { servers: [] },
  search: { provider: 'duckduckgo', apiKey: '', endpoint: '', maxResults: 5 },
}
