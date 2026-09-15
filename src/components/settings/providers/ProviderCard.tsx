import { useEffect, useState } from 'react'
import { Check, Loader2, Plug, RefreshCw, Trash2 } from 'lucide-react'
import type { ProviderConfig } from '@/types/backend'
import { useConfigStore } from '@/stores/useConfigStore'
import { listProviderModels } from '@/lib/providerApi'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { AdvancedPanel } from './AdvancedPanel'
import { IconButton } from '@/components/ui/IconButton'

/* ══════════════════════════════════════════════════════════════
   单个供应商的编辑卡片

   API Key 从主进程读回来是圆点掩码；写回去时会被 store 过滤掉，
   否则真 key 会被一串圆点覆盖。这是这一页最容易出的 bug。
   ══════════════════════════════════════════════════════════════ */

export interface ProviderCardProps {
  provider: ProviderConfig
}

export function ProviderCard({ provider }: ProviderCardProps) {
  const update = useConfigStore((s) => s.updateProvider)
  const remove = useConfigStore((s) => s.removeProvider)
  const test = useConfigStore((s) => s.testProvider)
  const count = useConfigStore((s) => s.config?.providers.length ?? 1)

  const [keyDraft, setKeyDraft] = useState(provider.apiKey)
  const [modelsDraft, setModelsDraft] = useState(provider.models.join(', '))
  const [testing, setTesting] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  /* 外部（重置配置等）改了 provider，输入框要跟着同步 */
  useEffect(() => {
    setKeyDraft(provider.apiKey)
    setModelsDraft(provider.models.join(', '))
  }, [provider.apiKey, provider.models])

  async function runTest(): Promise<void> {
    setTesting(true)
    setResult(null)
    const res = await test(provider.id)
    setTesting(false)
    setResult(
      res.ok
        ? { ok: true, text: `连上了，模型 ${res.model ?? '未知'}` }
        : { ok: false, text: res.error ?? '连接失败' },
    )
  }

  /** 从这家供应商的 /models 接口拉清单，合并进模型列表 */
  async function fetchModels(): Promise<void> {
    if (!provider.baseUrl) {
      setResult({ ok: false, text: '先填接口地址' })
      return
    }
    if (!keyDraft) {
      setResult({ ok: false, text: '先填 API Key' })
      return
    }

    setFetching(true)
    setResult(null)
    const res = await listProviderModels(provider.id)
    setFetching(false)

    if (!res.ok || !res.models) {
      setResult({ ok: false, text: res.error ?? '拉取失败' })
      return
    }

    /* 合并：用户手打的名字留着 */
    const merged = [...new Set([...provider.models, ...res.models])]
    setModelsDraft(merged.join(', '))
    await update(provider.id, { models: merged })
    setResult({ ok: true, text: `拉到 ${res.models.length} 个模型` })
  }

  return (
    <div className="nested-panel rounded-base border border-line-hairline bg-bg-raised/30 p-3">
      <div className="flex items-center gap-2">
        <Plug size={14} className="shrink-0 text-fg-tertiary" />
        <input
          value={provider.name}
          onChange={(e) => void update(provider.id, { name: e.target.value })}
          aria-label="供应商名称"
          className="min-w-0 flex-1 bg-transparent text-dense font-medium text-fg-primary focus:outline-none"
        />
        <label className="flex shrink-0 items-center gap-1.5 text-2xs text-fg-tertiary">
          <input
            type="checkbox"
            checked={provider.enabled}
            onChange={(e) => void update(provider.id, { enabled: e.target.checked })}
            className="accent-[var(--text-primary)]"
          />
          启用
        </label>
        {count > 1 ? (
          <IconButton label="删除这个供应商" size={28} onClick={() => void remove(provider.id)}>
            <Trash2 size={13} />
          </IconButton>
        ) : null}
      </div>

      <div className="mt-3 flex flex-col gap-2">
        <label className="block">
          <span className="mb-1 block text-2xs text-fg-tertiary">接口地址（baseUrl）</span>
          <Field
            value={provider.baseUrl}
            onChange={(v) => void update(provider.id, { baseUrl: v })}
            placeholder="https://api.deepseek.com/v1"
            spellCheck={false}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-2xs text-fg-tertiary">
            API Key
            <span className="ml-1.5 text-fg-tertiary/70">
              （只存在本机 data/config.json，界面上不回显）
            </span>
          </span>
          <Field
            type="password"
            value={keyDraft}
            onChange={(v) => {
              setKeyDraft(v)
              void update(provider.id, { apiKey: v })
            }}
            placeholder="sk-…"
            spellCheck={false}
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-2xs text-fg-tertiary">对话路径</span>
            <Field
              value={provider.chatPath}
              onChange={(v) => void update(provider.id, { chatPath: v })}
              placeholder="/chat/completions"
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1 flex items-center gap-2 text-2xs text-fg-tertiary">
              模型列表（逗号分隔）
              <button
                type="button"
                onClick={() => void fetchModels()}
                disabled={fetching}
                title="从这个供应商的 /models 接口拉取"
                className="ml-auto inline-flex items-center rounded-sm px-1.5 py-0.5 transition-colors hover:bg-bg-hover hover:text-fg-primary disabled:opacity-50"
              >
                {fetching ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <RefreshCw size={11} />
                )}
              </button>
            </span>
            <Field
              value={modelsDraft}
              onChange={(v) => {
                setModelsDraft(v)
                void update(provider.id, {
                  models: v
                    .split(',')
                    .map((m) => m.trim())
                    .filter(Boolean),
                })
              }}
              placeholder="deepseek-chat, deepseek-reasoner"
              spellCheck={false}
            />
          </label>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" variant="secondary" loading={testing} onClick={() => void runTest()}>
          测试连接
        </Button>

        {result ? (
          <span
            className="flex items-center gap-1 text-2xs"
            style={{ color: result.ok ? 'var(--success)' : 'var(--error)' }}
            role="status"
            aria-live="polite"
          >
            {result.ok ? <Check size={11} /> : null}
            {result.text}
          </span>
        ) : null}
      </div>

      <AdvancedPanel provider={provider} />
    </div>
  )
}
