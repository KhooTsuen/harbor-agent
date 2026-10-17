import { useEffect, useState } from 'react'
import type { ProjectTestItem, ProjectTestsSettings, ProjectTestsState } from '@/types/projectTests'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { useUIStore } from '@/stores/useUIStore'
import { Row, SectionTitle } from './parts'

/* ══════════════════════════════════════════════════════════════
   设置 → 扩展 → 项目测试（2026-10-17 · 3A）

   ── 它做什么 ──────────────────────────────────────────────────
   让用户为**自己的项目**写一条测试命令（项目根 + 命令 + 超时），
   DeepSeek 与 Codex 都能跑它 —— 但模型只能点名 `id`，给不出命令。

   ── 界面上的判断全部来自主进程 ────────────────────────────────
   `rootValid` / `commandValid` / `usable` 都是主进程算好的。
   前端不自己判「这个目录行不行」—— 那会把校验做成装饰品。

   ── 默认全关 ──────────────────────────────────────────────────
   不打开的话，模型叫不动任何项目测试。
   ══════════════════════════════════════════════════════════════ */

const EMPTY: ProjectTestsState = {
  enabled: false,
  items: [],
  statuses: {},
  limits: { items: 8, command: 300, root: 500, label: 60, timeoutSec: 600, defaultTimeoutSec: 300 },
}

const bridge = typeof window !== 'undefined' ? window.workbench : undefined

/** 空草稿 */
function blank(): ProjectTestItem {
  return { id: '', label: '', root: '', command: '', timeoutSec: 300 }
}

/** 状态徽标 */
function Tag({ ok, text, bad }: { ok: boolean; text: string; bad?: string }): React.JSX.Element {
  return (
    <span className={ok ? 'text-fg-success' : 'text-fg-danger'}>
      {text}
      {!ok && bad ? `：${bad}` : ''}
    </span>
  )
}

export function ProjectTestsPanel() {
  const showToast = useUIStore((s) => s.showToast)
  const [state, setState] = useState<ProjectTestsState>(EMPTY)
  const [draft, setDraft] = useState<ProjectTestItem>(blank())
  const [busy, setBusy] = useState(false)

  async function refresh(): Promise<void> {
    if (!bridge?.projectTestsStatus) return
    const res = await bridge.projectTestsStatus()
    if (res?.ok) setState(res.state)
  }

  useEffect(() => {
    void refresh()
  }, [])

  /** 保存整份（enabled + items）。主进程会逐条校验并整批拒/整批收 */
  async function save(settings: ProjectTestsSettings): Promise<boolean> {
    if (!bridge?.projectTestsSet) {
      showToast('warning', '浏览器预览下不可用', '这些设置只在桌面版生效')
      return false
    }
    setBusy(true)
    const res = await bridge.projectTestsSet(settings)
    setBusy(false)
    if (!res?.ok) {
      showToast('error', '没保存', res?.error ?? '主进程拒绝了这次修改')
      if (res?.state) setState(res.state)
      return false
    }
    setState(res.state)
    return true
  }

  /** 加一条（先本地粗筛空值，真正的判据在主进程） */
  async function add(): Promise<void> {
    if (!draft.root.trim() || !draft.command.trim()) {
      showToast('warning', '填完整', '项目根和命令都要填')
      return
    }
    const item: ProjectTestItem = {
      id: draft.id.trim() || `pt${state.items.length + 1}`,
      label: draft.label.trim() || draft.id.trim() || `项目测试 ${state.items.length + 1}`,
      root: draft.root.trim(),
      command: draft.command.trim(),
      timeoutSec: draft.timeoutSec,
    }
    const ok = await save({ enabled: state.enabled, items: [...state.items, item] })
    if (ok) {
      setDraft(blank())
      showToast('success', '已添加', `${item.id}（还要打开总开关才能跑）`)
    }
  }

  async function remove(id: string): Promise<void> {
    const items = state.items.filter((x) => x.id !== id).map(toPlain)
    await save({ enabled: state.enabled, items })
  }

  return (
    <div>
      <SectionTitle hint="为你的项目写一条测试命令。模型只能点名跑哪一条，给不出命令；默认关闭，执行前仍会弹确认。">
        项目测试
      </SectionTitle>

      <Row
        label="启用项目测试"
        hint="关掉后新请求立刻被拒（每次现读配置）；开着也只是允许跑下面这些条目"
      >
        <div className="flex items-center gap-3">
          <Tag ok={state.enabled} text={state.enabled ? '已启用' : '未启用'} />
          <Button
            variant={state.enabled ? 'ghost' : 'primary'}
            size="sm"
            disabled={busy}
            onClick={() => void save({ enabled: !state.enabled, items: state.items.map(toPlain) })}
          >
            {state.enabled ? '关闭' : '启用'}
          </Button>
        </div>
      </Row>

      <div className="mt-2 rounded-md border border-line-subtle bg-bg-raised px-3 py-2 text-dense text-fg-secondary">
        <p className="font-medium text-fg-primary">
          项目测试会以当前用户权限运行，可能访问项目外文件和网络。仅对可信项目启用。
        </p>
        <p className="mt-1">
          Harbor 没有进程级隔离（没有文件系统 / 网络沙箱）。
          <code className="font-mono">npm test</code> 这类脚本内部能做什么，事前看不出来 ——
          所以这里的边界是「你亲笔授权这条命令 + 每次执行都弹确认 +
          审计留痕」，不是「已经证明它只读」。取消 / 超时会连受控子进程一起终止，
          但脱离进程树的进程无法保证收回。
        </p>
      </div>

      {state.items.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2">
          {state.items.map((item) => (
            <li key={item.id} className="acrylic-card flex items-start gap-2 p-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-dense text-fg-primary">{item.label}</span>
                  <span className="font-mono text-2xs text-fg-tertiary">{item.id}</span>
                  <Tag
                    ok={item.usable}
                    text={item.usable ? '可用' : '不可用'}
                    bad={
                      !item.rootValid ? item.rootError : !item.commandValid ? item.commandError : ''
                    }
                  />
                </div>
                <p className="mt-1 truncate font-mono text-2xs text-fg-secondary">{item.command}</p>
                <p className="mt-0.5 truncate font-mono text-2xs text-fg-tertiary">
                  {item.root} · 超时 {item.timeoutSec}s
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void remove(item.id)}
              >
                删除
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-dense text-fg-tertiary">还没有条目。下面填一条试试。</p>
      )}

      <Row label="新增一条" hint="项目根必须在 Harbor 允许的数据根之内（主进程会校验并给出原因）">
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Field
              value={draft.id}
              onChange={(v) => setDraft({ ...draft, id: v })}
              placeholder="id（留空自动编号）"
            />
            <Field
              value={draft.label}
              onChange={(v) => setDraft({ ...draft, label: v })}
              placeholder="名称（给人看）"
            />
          </div>
          <Field
            value={draft.root}
            onChange={(v) => setDraft({ ...draft, root: v })}
            placeholder="项目根，例如 E:\CodexWorkbench\data\unit-test-data\my-proj"
          />
          <Field
            value={draft.command}
            onChange={(v) => setDraft({ ...draft, command: v })}
            placeholder="命令，例如 npm test 或 node --test（不许带 & | < > ^ % 引号）"
          />
          <div className="flex items-center gap-2">
            <Field
              value={String(draft.timeoutSec)}
              onChange={(v) => setDraft({ ...draft, timeoutSec: Number(v) || 0 })}
              placeholder="超时秒数（5 ~ 600，默认 300）"
            />
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void add()}>
              添加
            </Button>
          </div>
        </div>
      </Row>

      <Row label="执行状态" hint="六种状态分开报，退出码非 0 一律算失败（不会包装成成功）">
        <span className="text-dense text-fg-secondary">
          {Object.values(state.statuses).join(' / ') ||
            'PASS / FAIL / TIMEOUT / CANCELLED / DENIED / ERROR'}
        </span>
      </Row>

      <Row label="审批" hint="每次执行都会弹 PermissionBar —— 不可关闭">
        <span className="text-fg-success">逐次审批</span>
      </Row>
    </div>
  )
}

/** 界面上的条目 → 配置形状（去掉主进程算出来的校验字段） */
function toPlain(item: ProjectTestItem): ProjectTestItem {
  return {
    id: item.id,
    label: item.label,
    root: item.root,
    command: item.command,
    timeoutSec: item.timeoutSec,
  }
}
