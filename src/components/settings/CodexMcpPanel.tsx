import { useEffect, useState } from 'react'
import { RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { CodexMcpSettings, CodexMcpState } from '@/types/codexMcp'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { useUIStore } from '@/stores/useUIStore'
import { Row, SectionTitle } from './parts'

/* ══════════════════════════════════════════════════════════════
   设置 → 扩展 → Codex MCP 桥（2026-10-17 第四阶段）

   ── 这一块显示的是**主进程算出来的真实状态** ──────────────────
   不是从 config 里读「用户填了什么」。区别很关键：用户开了总开关但没重启，
   配置里是 true、桥其实没装配 —— 这里必须显示「未生效（需重启）」，
   否则就是「界面说已启用、后端其实没启用」（用户第 6 条）。

   ── 默认全关 ──────────────────────────────────────────────────
   四项默认 false / 空。用户不主动开，Codex 拿不到任何 Harbor 能力。

   ── 逐次审批不可关 ────────────────────────────────────────────
   「每次写入都要你点允许」是硬编码的（写与受限测试都走 PermissionBar）。
   这里只**如实展示**，不给开关 —— 给它就等于给了绕过审批的路。
   ══════════════════════════════════════════════════════════════ */

const EMPTY: CodexMcpState = {
  mcp: { enabled: false, source: 'config' },
  write: { enabled: false, root: '', rootValid: false, source: 'config' },
  runTest: { enabled: false, root: '', rootValid: false, source: 'config' },
  approval: { perRequest: true, ui: 'PermissionBar' },
  needsRestart: false,
  installedAt: 0,
}

const bridge = typeof window !== 'undefined' ? window.workbench : undefined

/** 状态徽标 —— 一眼看出开没开 */
function Badge({ on, env }: { on: boolean; env: boolean }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      {on ? (
        <ShieldCheck size={13} className="text-fg-success" />
      ) : (
        <ShieldAlert size={13} className="text-fg-tertiary" />
      )}
      <span className={on ? 'text-fg-success' : 'text-fg-tertiary'}>
        {on ? '已启用' : '未启用'}
      </span>
      {env ? <span className="text-fg-warning">（环境变量覆盖）</span> : null}
    </span>
  )
}

export function CodexMcpPanel() {
  const showToast = useUIStore((s) => s.showToast)
  const [state, setState] = useState<CodexMcpState>(EMPTY)
  const [settings, setSettings] = useState<CodexMcpSettings>({
    enabled: false,
    write: false,
    writeRoot: '',
    runTest: false,
  })
  const [rootDraft, setRootDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [rootError, setRootError] = useState('')

  async function refresh(): Promise<void> {
    if (!bridge?.codexMcpStatus) return
    const res = await bridge.codexMcpStatus()
    if (!res?.ok) return
    setState(res.state)
    setSettings((prev) => ({ ...prev, enabled: res.state.mcp.enabled }))
    setRootDraft(res.state.write.root ?? '')
  }

  useEffect(() => {
    void refresh()
  }, [])

  /** 改一项设置。**写目录由主进程验**，拒了就把原文显示出来（不静默吞掉） */
  async function apply(patch: Partial<CodexMcpSettings>): Promise<void> {
    if (!bridge?.codexMcpSet) {
      showToast('warning', '浏览器预览下不可用', '这些开关只在桌面版生效')
      return
    }
    setBusy(true)
    setRootError('')
    const res = await bridge.codexMcpSet(patch)
    setBusy(false)
    if (!res?.ok) {
      setRootError(res?.error ?? '保存失败')
      showToast('error', '没保存', res?.error ?? '主进程拒绝了这次修改')
      return
    }
    setState(res.state)
    showToast('success', '已保存', res.state.needsRestart ? '总开关需重启应用后生效' : '设置已生效')
  }

  const merged = { ...settings, ...state, needsRestart: state.needsRestart }

  return (
    <div>
      <SectionTitle hint="让外部 Codex CLI 经本机命名管道调用 Harbor 的工具。默认全关；开着也仍需逐次审批。">
        Codex MCP 桥
      </SectionTitle>

      {state.needsRestart ? (
        <div className="mb-2 rounded-md border border-line-warning bg-bg-raised px-3 py-2 text-dense text-fg-warning">
          总开关已改动，但桥是在应用启动时装配的 —— <strong>重启应用后才会真正生效</strong>。
          界面不会把未生效的状态显示成「已启用」。
        </div>
      ) : null}

      <Row label="MCP 桥" hint="关掉后 Codex 没有任何 Harbor 工具可用；改它需要重启应用">
        <div className="flex items-center gap-3">
          <Badge on={merged.mcp.enabled} env={merged.mcp.source === 'env'} />
          <Button
            variant={merged.mcp.enabled ? 'ghost' : 'primary'}
            size="sm"
            disabled={busy}
            onClick={() => void apply({ enabled: !merged.mcp.enabled })}
          >
            {merged.mcp.enabled ? '关闭' : '启用'}
          </Button>
        </div>
      </Row>

      <Row label="允许写入" hint="只允许写下面那个隔离工作区。关掉后新请求立刻被拒，不用重启">
        <div className="flex items-center gap-3">
          <Badge on={merged.write.enabled} env={merged.write.source === 'env'} />
          <Button
            variant={merged.write.enabled ? 'ghost' : 'primary'}
            size="sm"
            disabled={busy}
            onClick={() => void apply({ write: !merged.write.enabled })}
          >
            {merged.write.enabled ? '关闭' : '启用'}
          </Button>
        </div>
      </Row>

      <Row
        label="允许写入的工作区"
        hint="必须是隔离测试目录（主进程会校验；越界 / 符号链接 / 目录联接一律拒绝）"
      >
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Field
              value={rootDraft}
              onChange={setRootDraft}
              placeholder="E:\CodexWorkbench\data\unit-test-data\my-project"
            />
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => void apply({ writeRoot: rootDraft.trim() })}
            >
              保存
            </Button>
          </div>
          {rootError ? <span className="text-dense text-fg-danger">{rootError}</span> : null}
          {!rootError && merged.write.root && merged.write.rootValid === false ? (
            <span className="text-dense text-fg-danger">{merged.write.rootError}</span>
          ) : null}
          {!rootError && merged.write.root && merged.write.rootValid ? (
            <span className="truncate font-mono text-2xs text-fg-tertiary">
              {merged.write.root}
            </span>
          ) : null}
        </div>
      </Row>

      <Row
        label="受限测试执行"
        hint="只跑预先允许的测试（命令与工作目录都由 Harbor 固定），不接受任意命令"
      >
        <div className="flex items-center gap-3">
          <Badge on={merged.runTest.enabled} env={merged.runTest.source === 'env'} />
          <Button
            variant={merged.runTest.enabled ? 'ghost' : 'primary'}
            size="sm"
            disabled={busy}
            onClick={() => void apply({ runTest: !merged.runTest.enabled })}
          >
            {merged.runTest.enabled ? '关闭' : '启用'}
          </Button>
        </div>
      </Row>

      <Row label="审批" hint="写入与测试执行都走这张卡 —— 每次单独询问，不可关闭">
        <span className="flex items-center gap-1.5 text-fg-success">
          <ShieldCheck size={13} />
          逐次审批（PermissionBar）
        </span>
      </Row>

      <Row label="刷新状态" hint="状态来自主进程（不是本地缓存）">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw size={13} className="mr-1" />
          重新读取
        </Button>
      </Row>
    </div>
  )
}
