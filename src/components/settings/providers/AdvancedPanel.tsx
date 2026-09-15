import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Check } from 'lucide-react'
import type { ProviderConfig } from '@/types/backend'
import { useConfigStore } from '@/stores/useConfigStore'
import { Field } from '@/components/ui/Field'

/* ══════════════════════════════════════════════════════════════
   供应商 → 高级（默认折叠）

   给中转站和怪站点留的兜底，普通用户不用看：

     extraBody   直接 merge 进请求体，优先级最高
                 （OpenRouter 的后端选择 `{"provider":{"order":[...]}}`、
                   硅基流动 Qwen3 的 `{"enable_thinking":false}` 都走这里）
     omitParams  明确不要发的字段名
     streamUsage 要不要让上游回 usage（不认 stream_options 的站点要关）

   为什么是折叠的：这三项 99% 的人不需要，摆在主表单里只会让人以为必须填。
   ══════════════════════════════════════════════════════════════ */

export function AdvancedPanel({ provider }: { provider: ProviderConfig }): React.ReactElement {
  const update = useConfigStore((s) => s.updateProvider)
  const [open, setOpen] = useState(false)

  /* extraBody 用「草稿 + 应用」：JSON 不能边打边存，否则中途的半个 JSON 会落进配置 */
  const [draft, setDraft] = useState(() => JSON.stringify(provider.extraBody ?? {}, null, 2))
  const [jsonError, setJsonError] = useState('')
  const [applied, setApplied] = useState(false)

  const omitText = (provider.omitParams ?? []).join(', ')

  function applyExtraBody(): void {
    const text = draft.trim()
    if (!text) {
      setJsonError('')
      void update(provider.id, { extraBody: {} })
      setApplied(true)
      return
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setJsonError('要是一个 JSON 对象，比如 {"top_k": 40}')
        return
      }
      setJsonError('')
      void update(provider.id, { extraBody: parsed as Record<string, unknown> })
      setApplied(true)
      setTimeout(() => setApplied(false), 1500)
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : 'JSON 解析失败')
    }
  }

  return (
    <div className="mt-3 border-t border-line-hairline pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-2xs text-fg-tertiary transition-colors hover:text-fg-primary"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        高级（中转站兼容）
      </button>

      {open ? (
        <div className="mt-2 flex flex-col gap-2.5">
          <label className="flex items-start gap-2 text-dense text-fg-primary">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={provider.streamUsage !== false}
              onChange={(e) => void update(provider.id, { streamUsage: e.target.checked })}
            />
            <span>
              让上游返回用量
              <span className="ml-1.5 text-2xs text-fg-tertiary">
                （不认 stream_options 的站点会 400，那时关掉它）
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-dense text-fg-primary">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={provider.strictTools === true}
              onChange={(e) => void update(provider.id, { strictTools: e.target.checked })}
            />
            <span>
              DeepSeek strict 模式
              <span className="ml-1.5 text-2xs text-fg-tertiary">
                （给工具参数加 strict 校验，仅 DeepSeek 官方
                <code className="text-2xs">/beta</code> 端点有效：要把 Base URL 改成
                .../beta；中转站别开）
              </span>
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-2xs text-fg-tertiary">不要发送的参数（逗号分隔）</span>
            <Field
              value={omitText}
              onChange={(v) => {
                const list = v
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
                void update(provider.id, { omitParams: list })
              }}
              placeholder="temperature, top_p"
              spellCheck={false}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-2xs text-fg-tertiary">
              额外请求体（JSON，优先级最高）
              <span className="ml-1.5 text-fg-tertiary/70">
                （OpenRouter 的后端选择、Qwen3 的 enable_thinking 都写这里）
              </span>
            </span>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder={'{\n  "provider": { "order": ["DeepInfra"] }\n}'}
              className="w-full resize-y rounded-small border border-line-hairline bg-bg-raised px-2 py-1.5 font-mono text-2xs leading-relaxed text-fg-primary outline-none focus:border-line-strong"
            />
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={applyExtraBody}
              className="rounded-small border border-line-hairline px-2 py-1 text-2xs text-fg-secondary transition-colors hover:bg-bg-hover hover:text-fg-primary"
            >
              应用
            </button>
            {applied ? (
              <span
                className="flex items-center gap-1 text-2xs"
                style={{ color: 'var(--success)' }}
              >
                <Check size={11} /> 已保存
              </span>
            ) : null}
            {jsonError ? (
              <span
                className="flex items-center gap-1 text-2xs"
                style={{ color: 'var(--error)' }}
                role="status"
                aria-live="polite"
              >
                <AlertTriangle size={11} /> {jsonError}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
