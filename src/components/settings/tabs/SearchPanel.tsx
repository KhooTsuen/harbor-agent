import { useEffect, useState } from 'react'
import { Check, SearchIcon } from 'lucide-react'
import { searchProviders, testSearch } from '@/lib/extrasApi'
import { useConfigStore } from '@/stores/useConfigStore'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'

/* ══════════════════════════════════════════════════════════════
   搜索配置（放在「工具」页里）

   为什么要让用户选后端：国内网络下 DuckDuckGo 经常不通，Tavily 要付费。
   写死一个总有一半人不能用。
   ══════════════════════════════════════════════════════════════ */

interface ProviderOption {
  id: string
  label: string
  needKey: boolean
}

export function SearchPanel() {
  const config = useConfigStore((s) => s.config)
  const patchSearch = useConfigStore((s) => s.patchSearch)

  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [keyDraft, setKeyDraft] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const search = config?.search

  useEffect(() => {
    void (async () => setProviders(await searchProviders()))()
  }, [])

  useEffect(() => {
    setKeyDraft(search?.apiKey ?? '')
  }, [search?.apiKey])

  if (!config || !search) {
    return (
      <p className="py-3 text-2xs leading-relaxed text-fg-tertiary">
        当前运行在浏览器预览环境，联网搜索配置请在桌面版中使用。
      </p>
    )
  }

  /* 提前解构：闭包里 TS 收不住 search 的非空判断 */
  const providerId = search.provider
  const endpoint = search.endpoint
  const current = providers.find((p) => p.id === providerId)
  const needKey = current?.needKey === true
  const isCustom = providerId === 'custom'

  async function runTest(): Promise<void> {
    setTesting(true)
    setResult(null)
    const res = await testSearch({
      provider: providerId,
      apiKey: keyDraft,
      endpoint,
    })
    setTesting(false)
    setResult(
      res.ok
        ? {
            ok: true,
            text: `通了，返回 ${res.count} 条${res.sample ? `（第一条：${res.sample}）` : ''}`,
          }
        : { ok: false, text: res.error ?? '失败' },
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="block px-3.5 py-3">
        <span className="mb-1 block text-2xs text-fg-tertiary">搜索服务</span>
        <select
          value={search.provider}
          onChange={(e) => {
            void patchSearch({ provider: e.target.value })
            setResult(null)
          }}
          className="w-full rounded-base border border-line-hairline bg-bg-surface px-2.5 py-1.5 text-dense text-fg-primary focus:border-line-focus focus:outline-none"
        >
          {(providers.length > 0
            ? providers
            : [
                { id: 'duckduckgo', label: 'DuckDuckGo', needKey: false },
                { id: 'tavily', label: 'Tavily', needKey: true },
                { id: 'bocha', label: '博查', needKey: true },
                { id: 'custom', label: '自定义', needKey: false },
              ]
          ).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.needKey ? '（需要 Key）' : '（免费）'}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-2xs text-fg-tertiary">
          DuckDuckGo 免费但要看网络能不能通；Tavily 质量好要 Key；国内建议博查。
        </span>
      </label>

      {needKey ? (
        <label className="block px-3.5 py-3">
          <span className="mb-1 block text-2xs text-fg-tertiary">搜索服务的 API Key</span>
          <Field
            type="password"
            value={keyDraft}
            onChange={(v) => {
              setKeyDraft(v)
              void patchSearch({ apiKey: v })
            }}
            placeholder="填进去才生效"
            spellCheck={false}
          />
        </label>
      ) : null}

      {isCustom ? (
        <label className="block px-3.5 py-3">
          <span className="mb-1 block text-2xs text-fg-tertiary">
            URL 模板（用 {'{query}'} 占位）
          </span>
          <Field
            value={search.endpoint}
            onChange={(v) => void patchSearch({ endpoint: v })}
            placeholder="https://example.com/search?q={query}"
            spellCheck={false}
          />
        </label>
      ) : null}

      <label className="block px-3.5 py-3">
        <span className="mb-1 block text-2xs text-fg-tertiary">每次返回几条结果</span>
        <Field
          type="number"
          value={String(search.maxResults)}
          onChange={(v) => void patchSearch({ maxResults: Number(v) || 5 })}
        />
      </label>

      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<SearchIcon size={13} />}
          loading={testing}
          onClick={() => void runTest()}
        >
          测一下
        </Button>
        {result ? (
          <span
            className="flex min-w-0 items-center gap-1 text-2xs"
            style={{ color: result.ok ? 'var(--success)' : 'var(--error)' }}
            role="status"
            aria-live="polite"
          >
            {result.ok ? <Check size={11} className="shrink-0" /> : null}
            <span className="truncate">{result.text}</span>
          </span>
        ) : null}
      </div>
    </div>
  )
}
