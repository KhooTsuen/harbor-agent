/**
 * 「ChatGPT Codex CLI」后端卡片（实验性）—— 2026-10-17
 *
 * ── 为什么单独一张卡，而不是在 `ProviderCard` 里加分支 ──────────
 *
 * 那种后端**没有 baseUrl、没有 API Key、不拉 /models**：它的字段与 HTTP 供应商
 * 几乎不重叠。塞进同一张卡要么满屏「不适用」的空框，要么改一堆现有 JSX。
 * 另外 `ProviderCard` 开头就调了一串 hooks —— 在它内部提前 `return` 会违反
 * hooks 规则（两轮之间 hooks 数量不同）。所以分流放在调用点（`ProviderPanel`）。
 *
 * ── ★ 卡片上必须写明的话（用户 2026-10-17 第 3、9 条）───────────
 *
 * 「不宣称支持 Harbor 原生工具调用」这件事**必须写在用户看得见的地方**，
 * 只写在代码注释里等于没写。所以下面那几条限制是**卡片正文**，不是附注。
 * 依据见 `docs/research/codex-cli-adapter-design.md` §2/§4（每条都有实测）。
 */

import { useEffect, useState } from 'react'
import type { ProviderConfig } from '@/types/backend'
import { useConfigStore } from '@/stores/useConfigStore'
import { Field } from '@/components/ui/Field'
import { IconButton } from '@/components/ui/IconButton'
import { Terminal, Trash2 } from 'lucide-react'
import { ModelCapabilityList } from './ModelCapabilityList'

export interface CodexCliCardProps {
  provider: ProviderConfig
}

export function CodexCliCard({ provider }: CodexCliCardProps) {
  const update = useConfigStore((s) => s.updateProvider)
  const remove = useConfigStore((s) => s.removeProvider)
  const count = useConfigStore((s) => s.config?.providers.length ?? 1)
  const [modelsDraft, setModelsDraft] = useState(provider.models.join(', '))

  /* 外部（重置配置等）改了 provider，输入框要跟着同步 */
  useEffect(() => {
    setModelsDraft(provider.models.join(', '))
  }, [provider.models])

  return (
    <div className="acrylic-card rounded-base border border-line-hairline p-3">
      <div className="flex items-center gap-2">
        <Terminal size={14} className="shrink-0 text-fg-tertiary" />
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

      <p className="mt-2 text-2xs leading-relaxed text-fg-secondary">
        这个后端不用填 API Key：推理走本机已登录的 ChatGPT Codex CLI。Harbor 不保存、不复制你的
        ChatGPT 登录凭据 —— 它只负责启动本机那个命令行程序。
      </p>

      {/* ★ 能力限制：如实写在卡片上（不是附注） */}
      <div className="mt-2 rounded-sm border border-line-hairline bg-bg-subtle/40 p-2">
        <p className="text-2xs font-medium text-fg-secondary">已知限制（如实说明）</p>
        <ul className="mt-1 list-disc pl-4 text-2xs leading-relaxed text-fg-tertiary">
          <li>
            <span className="text-fg-secondary">不支持 Harbor 的工具调用</span>
            ：读写文件 / 跑命令 / 操作浏览器在这个后端下用不了（Codex CLI 不产出工具调用）。
          </li>
          <li>回复是整段出现的，不是逐字打字机效果。</li>
          <li>首次调用可能明显较慢（要连 ChatGPT，本机可能还需要代理）。</li>
          <li>不能读图、不能联网搜索。</li>
        </ul>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        <label className="block">
          <span className="mb-1 block text-2xs text-fg-tertiary">
            启动器路径
            <span className="ml-1.5 text-fg-tertiary/70">（留空 = 自动在 PATH 里找 codex）</span>
          </span>
          <Field
            value={provider.codexPath ?? ''}
            onChange={(v) => void update(provider.id, { codexPath: v })}
            placeholder="留空即可；非默认安装位置时填完整路径"
            spellCheck={false}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-2xs text-fg-tertiary">
            代理地址
            <span className="ml-1.5 text-fg-tertiary/70">
              （可留空 = 不设代理；本机/公司网络下 Codex 连不上 ChatGPT 时再填）
            </span>
          </span>
          <Field
            value={provider.proxy ?? ''}
            onChange={(v) => void update(provider.id, { proxy: v })}
            placeholder="留空；需要时形如 http://127.0.0.1:8080"
            spellCheck={false}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-2xs text-fg-tertiary">
            模型标识（逗号分隔）
            <span className="ml-1.5 text-fg-tertiary/70">
              （只是 Harbor 里选它用的名字，具体模型由 Codex 自己的配置决定）
            </span>
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
            placeholder="codex-cli"
            spellCheck={false}
          />
        </label>

        {/* 能力矩阵：这一格会按**后端种类**显示（tool_call 明确为「不支持」，见 provider-capabilities.cjs） */}
        <ModelCapabilityList models={provider.models} providerId={provider.id} />
      </div>
    </div>
  )
}
