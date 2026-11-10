/** Settings hold opt-in, shared limits and availability; A/B choices stay in the chat. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useUIStore } from '@/stores/useUIStore'
import type { CollabState, CollabSettings } from '@/types/collab'
import { Row, SectionTitle } from './parts'
import { CollabBudgetFields } from './CollabBudgetFields'

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
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)

  const refresh = useCallback(async () => {
    if (!bridge?.collabStatus) return
    try {
      const res = await bridge.collabStatus()
      if (!res?.ok || !res.state) throw new Error('协作状态暂时不可用')
      setState(res.state)
      setLoaded(true)
    } catch {
      showToast('error', '无法读取协作状态', '请稍后再试')
    }
  }, [showToast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = async (partial: Partial<CollabSettings>): Promise<boolean> => {
    if (!bridge?.collabSet || pending.current) return false
    pending.current = true
    setSaving(true)
    try {
      const res = await bridge.collabSet(partial)
      if (!res.ok || !res.state) throw new Error(res.error || '设置未被后台接受')
      setState(res.state)
      showToast(
        'success',
        partial.enabled === undefined
          ? '协作预算已保存'
          : partial.enabled
            ? '双模型协作已开启'
            : '双模型协作已关闭',
      )
      return true
    } catch (error) {
      showToast('error', '未能更新协作设置', error instanceof Error ? error.message : String(error))
      return false
    } finally {
      pending.current = false
      setSaving(false)
    }
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
            disabled={!loaded || saving}
            onChange={(e) => void save({ enabled: e.target.checked })}
          />
          <span>{state.enabled ? '已开启' : '已关闭'}</span>
        </label>
      </Row>

      <Row
        label="监督执行"
        hint="A 分派，B 执行，A 检查；有缺口时自动补查或修改，达到要求后由 A 整理答复。"
      >
        <span className="text-xs text-fg-muted">
          普通交接在现有授权内自动进行。关键需求不明或需要新授权时，再请你决定。
        </span>
      </Row>

      {state.limits ? (
        <Row
          label="协作预算"
          hint="整次协作共用轮数、时长和已报告 Token 上限；达到上限后保留结果与未完成事项。"
        >
          <CollabBudgetFields limits={state.limits} disabled={saving} onSave={save} />
        </Row>
      ) : null}

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
        hint="这里读取连接配置和本机启动入口；实际登录、网络与模型调用在执行时确认。"
      >
        <div className="space-y-1 text-xs text-fg-muted">
          <div>
            Codex CLI：
            {state.matrix['codex-cli'] ? (
              <span className="text-fg-success">已找到启动入口，登录尚未核验</span>
            ) : (
              <span className="text-fg-danger">
                不可用{state.codex.note ? `（${state.codex.note}）` : ''}
              </span>
            )}
          </div>
          <div>
            OpenAI 兼容：
            {state.matrix.openai ? (
              <span className="text-fg-success">已配置连接与凭据</span>
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
