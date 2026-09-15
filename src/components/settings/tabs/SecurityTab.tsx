import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, KeyRound, RefreshCw, Trash2 } from 'lucide-react'
import type { AuditEntry, CapabilityGrant, CredentialsStatus, RiskVerdict } from '@/types/backend'
import type { AppConfig, PolicyAction } from '@/types/models'
import { useConfigStore } from '@/stores/useConfigStore'
import { useUIStore } from '@/stores/useUIStore'
import { Button } from '@/components/ui/Button'
import {
  auditClear,
  auditList,
  auditStats,
  capabilityList,
  classifyCommand,
  credentialsStatus,
} from '@/lib/safetyApi'
import { Row, SectionTitle } from '../parts'
import { AuditPanel } from '../security/AuditPanel'
import { GrantsPanel } from '../security/GrantsPanel'
import { LEVEL_COLOR, LEVEL_LABEL, POLICY_OPTIONS, SCOPE_OPTIONS } from '../security/meta'

/* ══════════════════════════════════════════════════════════════
   设置 → 安全

   这一页的定位：**让用户能看清「Agent 到底被允许做什么」**，
   并且能随时收回权限。

   四块：
     ① 文件访问范围 —— 默认只给工作目录
     ② Shell 风险策略 —— 四档怎么处理
     ③ 已放开的路径 —— 能一条条撤
     ④ 审计日志 —— 谁在什么时候拿什么权限做了什么
   ══════════════════════════════════════════════════════════════ */

export function SecurityTab() {
  const config = useConfigStore((s) => s.config)
  const patchTools = useConfigStore((s) => s.patchTools)
  const showToast = useUIStore((s) => s.showToast)

  const [grants, setGrants] = useState<CapabilityGrant[]>([])
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [stats, setStats] = useState({ total: 0, failed: 0, denied: 0 })
  const [creds, setCreds] = useState<CredentialsStatus | null>(null)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [probe, setProbe] = useState('')
  const [probeResult, setProbeResult] = useState<{ verdict: RiskVerdict; action: string } | null>(
    null,
  )
  const [busy, setBusy] = useState(false)

  const tools = config?.tools

  const refresh = useCallback(async () => {
    setBusy(true)
    const [g, a, s, c] = await Promise.all([
      capabilityList(),
      auditList({ limit: 60, onlyProblems }),
      auditStats(7),
      credentialsStatus(),
    ])
    setGrants(g)
    setEntries(a.entries)
    setStats(s)
    setCreds(c)
    setBusy(false)
  }, [onlyProblems])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /* 桌面版才有的面板：浏览器预览里提示一句，别让人以为是坏了 */
  if (!creds && grants.length === 0 && entries.length === 0 && !busy) {
    return (
      <div className="p-3 text-2xs text-fg-tertiary">
        这些面板需要桌面版（浏览器预览没有主进程，看不到审计与授权记录）。
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1 pb-6">
      <SectionTitle>文件访问范围</SectionTitle>
      <Row
        label="Agent 能碰哪些文件"
        hint="默认只允许工作目录。要动外面时会在对话里弹窗问一次，批准后本次会话有效。"
      >
        <div className="flex flex-col gap-1">
          {SCOPE_OPTIONS.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-start gap-2 py-0.5">
              <input
                type="radio"
                name="fileScope"
                className="mt-1"
                checked={tools?.fileScope === option.value}
                onChange={() =>
                  void patchTools({ fileScope: option.value as AppConfig['tools']['fileScope'] })
                }
              />
              <span>
                <span className="text-dense text-fg-primary">{option.label}</span>
                <span className="ml-1.5 text-2xs text-fg-tertiary">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </Row>

      <SectionTitle>Shell 风险策略</SectionTitle>
      <Row label="中风险" hint="装依赖、构建、改 Git 状态、网络请求">
        <PolicySelect
          value={tools?.shellPolicy?.medium ?? 'ask'}
          onChange={(value) =>
            void patchTools({ shellPolicy: { ...fullPolicy(tools?.shellPolicy), medium: value } })
          }
        />
      </Row>
      <Row label="高风险" hint="递归删除、改注册表、提权、下载后执行">
        <PolicySelect
          value={tools?.shellPolicy?.high ?? 'ask'}
          onChange={(value) =>
            void patchTools({ shellPolicy: { ...fullPolicy(tools?.shellPolicy), high: value } })
          }
        />
      </Row>
      <Row
        label="危急"
        hint="格式化磁盘、破坏系统、抓凭据、关杀软。即使选了「直接执行」也不会静默放行"
      >
        <PolicySelect
          value={tools?.shellPolicy?.critical ?? 'block'}
          onChange={(value) =>
            void patchTools({ shellPolicy: { ...fullPolicy(tools?.shellPolicy), critical: value } })
          }
        />
      </Row>

      <Row label="试算一条命令" hint="输入命令看它会被判成什么等级（不执行）">
        <div className="flex flex-col gap-2">
          <input
            value={probe}
            onChange={(e) => setProbe(e.target.value)}
            placeholder="例如：rm -rf ./build"
            spellCheck={false}
            className="w-full rounded-sm border border-line-subtle bg-bg-raised px-2 py-1.5 font-mono text-xs text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void classifyCommand(probe).then(setProbeResult)}
            >
              试算
            </Button>
            {probeResult ? (
              <span className="text-2xs">
                <span style={{ color: LEVEL_COLOR[probeResult.verdict.level] }}>
                  {LEVEL_LABEL[probeResult.verdict.level]}风险
                </span>
                <span className="text-fg-tertiary">
                  {' '}
                  · 处置：
                  {POLICY_OPTIONS.find((p) => p.value === probeResult.action)?.label ??
                    probeResult.action}
                  {probeResult.verdict.reasons.length > 0
                    ? ` · ${probeResult.verdict.reasons.join('；')}`
                    : ''}
                </span>
              </span>
            ) : null}
          </div>
        </div>
      </Row>

      <GrantsPanel grants={grants} onChange={() => void refresh()} />

      <SectionTitle>审计日志</SectionTitle>
      <Row
        label="记录工具调用"
        hint="谁、什么时候、用什么权限、做了什么、成功没有。参数里的密钥会自动打码。"
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-dense text-fg-primary">
            <input
              type="checkbox"
              checked={config?.audit?.enabled !== false}
              onChange={(e) =>
                void useConfigStore.getState().patchAudit({ enabled: e.target.checked })
              }
            />
            开启审计
          </label>
          <label className="flex items-center gap-2 text-dense text-fg-primary">
            <input
              type="checkbox"
              checked={onlyProblems}
              onChange={(e) => setOnlyProblems(e.target.checked)}
            />
            只看失败的
          </label>
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={12} />}
            onClick={() => void refresh()}
          >
            刷新
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={12} />}
            onClick={() =>
              void auditClear().then((r) => {
                showToast('success', '已清空', `删了 ${r.removed} 个文件`)
                void refresh()
              })
            }
          >
            清空
          </Button>
        </div>
      </Row>

      <p className="pb-1 text-2xs text-fg-tertiary">
        最近 7 天：{stats.total} 次调用 · 失败 {stats.failed} · 被拒 {stats.denied}
      </p>

      <AuditPanel entries={entries} />

      <SectionTitle>密钥存放</SectionTitle>
      <Row
        label="凭证库"
        hint="API Key 不写进配置文件，单独存在凭证库里。系统加密可用时用 Windows DPAPI 加密。"
      >
        <div className="flex items-center gap-2 text-2xs">
          <KeyRound size={13} className="text-fg-tertiary" />
          {creds ? (
            creds.encryptionAvailable ? (
              <span className="text-fg-secondary">
                已用系统加密（{creds.backend}）· {creds.count} 条
              </span>
            ) : (
              <span className="flex items-center gap-1" style={{ color: 'var(--warning)' }}>
                <AlertTriangle size={12} />
                当前环境拿不到系统加密，密钥是明文存在本机文件里（别把 data/ 拷给别人）
              </span>
            )
          ) : (
            <span className="text-fg-tertiary">读不到</span>
          )}
        </div>
      </Row>
    </div>
  )
}

/** 补全三个键 —— patch 是浅合并，缺的键会把类型搞成可选 */
function fullPolicy(
  policy?: Partial<AppConfig['tools']['shellPolicy']>,
): AppConfig['tools']['shellPolicy'] {
  return { medium: 'ask', high: 'ask', critical: 'block', ...policy }
}

function PolicySelect({
  value,
  onChange,
}: {
  value: PolicyAction
  onChange: (value: PolicyAction) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as PolicyAction)}
      className="rounded-sm border border-line-subtle bg-bg-raised px-2 py-1 text-dense text-fg-primary focus:border-line-focus focus:outline-none"
    >
      {POLICY_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
