/**
 * 设置 → 扩展 → **双模型协作**（2026-10-17）
 *
 * ── 这里只做「开关 + 能力查看」───────────────────────────────
 *
 * 日常切换单模型/多模型、选 A/B、输入任务，**都在聊天框完成**（见
 * `chat/composer/CollabPicker.tsx`）。设置页不再有「开始协作」按钮和输入框 ——
 * 否则会和新入口形成两个互相冲突的运行状态（用户 2026-10-17 拍板）。
 *
 * ── 界面纪律 ──────────────────────────────────────────────────
 *
 *   · 判断全部来自主进程（`status.ready` / `blockers` / `matrix` 都是它算的）。
 *   · 默认关：聊天框保留入口，用户主动选择双模型时才开启。
 *   · 缺前提时直接说缺什么（`blockers` 原样列出）。
 *
 * ⚠️ 这里没有任何角色选择器：角色能力（A/B 各能胜任哪些 kind）由主进程声明。
 */

import { useCallback, useEffect, useState } from 'react'
import { useUIStore } from '@/stores/useUIStore'
import type { CollabState } from '@/types/collab'
import { Row, SectionTitle } from './parts'

const bridge = typeof window !== 'undefined' ? window.workbench : undefined

const EMPTY: CollabState = {
  enabled: false,
  roles: {},
  matrix: {},
  ready: false,
  blockers: [],
  codex: { ready: false, note: '' },
  projectTests: { enabled: false, count: 0 },
}

export function CollabPanel(): React.JSX.Element {
  const showToast = useUIStore((s) => s.showToast)
  const [state, setState] = useState<CollabState>(EMPTY)

  const refresh = useCallback(async () => {
    if (!bridge?.collabStatus) return
    const res = await bridge.collabStatus()
    if (res?.ok && res.state) setState(res.state as CollabState)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = async (next: boolean): Promise<void> => {
    if (!bridge?.collabSet) return
    const res = await bridge.collabSet({ enabled: next })
    if (res?.ok && res.state) setState(res.state as CollabState)
    showToast(next ? 'success' : 'info', next ? '双模型协作已开启' : '双模型协作已关闭')
  }

  const roles = Object.values(state.roles)

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>双模型协作</SectionTitle>

      <Row label="启用" hint="双模型默认关闭。你在聊天框主动选择双模型时会开启；也可以在这里关闭。">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <span>{state.enabled ? '已开启' : '已关闭'}</span>
        </label>
      </Row>

      {roles.length > 0 && (
        <Row label="角色与能力" hint="两个角色各自能由哪些后端承担（由主进程声明，不是探测）。">
          <div className="space-y-1 text-xs text-fg-muted">
            {roles.map((r) => (
              <div key={r.id}>
                <span className="text-fg">{r.label}</span> · {r.duty}
                <div className="mt-0.5 pl-3">
                  能承担的后端：{(r.kinds ?? []).join(' / ') || '（无）'}
                </div>
              </div>
            ))}
          </div>
        </Row>
      )}

      <Row
        label="后端现状"
        hint="codex-cli = 本机 Codex CLI；openai = 任一启用且有 Key 的 OpenAI 兼容供应商。"
      >
        <div className="space-y-1 text-xs text-fg-muted">
          <div>
            Codex CLI：
            {state.matrix['codex-cli'] ? (
              <span className="text-fg-success">可用</span>
            ) : (
              <span className="text-fg-danger">
                不可用{state.codex.note ? `（${state.codex.note}）` : ''}
              </span>
            )}
          </div>
          <div>
            OpenAI 兼容：
            {state.matrix.openai ? (
              <span className="text-fg-success">可用</span>
            ) : (
              <span className="text-fg-danger">不可用（没有启用且有 Key 的供应商）</span>
            )}
          </div>
        </div>
      </Row>

      {state.enabled && !state.ready && (
        <Row label="还不能跑" hint="下面每一条都得满足，才能在聊天框发起协作。">
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-fg-danger">
            {state.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Row>
      )}

      {state.enabled && (
        <Row
          label="怎么用"
          hint="回聊天框：点右下角模型选择器 → 「多模型协作」→ 选 A（指导）和 B（工作）→ 输入任务发送。"
        >
          <span className="text-xs text-fg-muted">
            协作的 A/B
            选择跟当前对话走；换一条对话可以各自不同。切回「单模型」就恢复原有独立模型工作方式。
          </span>
        </Row>
      )}
    </div>
  )
}
