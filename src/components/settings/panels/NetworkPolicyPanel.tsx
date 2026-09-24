import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Save } from 'lucide-react'
import { useUIStore } from '@/stores/useUIStore'
import { Button } from '@/components/ui/Button'
import {
  fetchNetworkPolicy,
  networkPolicyBridgeReady,
  parseHostLines,
  saveNetworkPolicy,
  type NetworkMode,
  type NetworkPolicyView,
} from '@/lib/networkPolicyApi'
import { Row, SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
   设置 → 权限与安全 → 网络策略

   三档模式 + 两个主机名单（`config.json` 的 `security.network`）。
   内核侧**真的会执行**它：`run_shell` 执行前、MCP 启动前各过一道
   （裁决顺序与理由在 `electron/core/net-policy.cjs` 的 `decide`）。

   两条不能省：

   ① 「这个开关的边界」那段说明**原样显示内核给的话**，界面上不重写。
      它写清了「管不到什么」（MCP 子进程自己的流量、浏览器标签页里
      第三方脚本…）—— 用户拿它当防火墙用，说得比实际强比没有这道关更危险。

   ② 保存失败必须让用户看见（toast 带原因）。配置没写进去却装作成功，
      用户会以为「已经禁掉了」，这比不给设置更糟。
   ══════════════════════════════════════════════════════════════ */

/** 三档模式：文案说的是**这个值实际会发生什么**，不是形容词 */
const MODE_OPTIONS: readonly { value: NetworkMode; label: string; hint: string }[] = [
  {
    value: 'allow',
    label: '允许',
    hint: '不问就放行。禁止名单里的主机照旧拦（禁止优先于允许）。',
  },
  {
    value: 'ask',
    label: '每次先问',
    hint: '默认。要联网时在对话里弹一次，你点了才走；允许名单里的主机免问。',
  },
  {
    value: 'deny',
    label: '禁止',
    hint: '一律不许。这一档下允许名单也不生效 —— 要放行得先离开这一档。',
  },
]

export function NetworkPolicyPanel() {
  const showToast = useUIStore((s) => s.showToast)
  const ready = networkPolicyBridgeReady()

  const [view, setView] = useState<NetworkPolicyView | null>(null)
  const [mode, setMode] = useState<NetworkMode>('ask')
  const [denyText, setDenyText] = useState('')
  const [allowText, setAllowText] = useState('')
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  /**
   * 读一遍内核的当前值和说明。
   * 保存之后也走它 —— 显示的是**内核认的值**，不是本地状态里那份猜测。
   */
  const load = useCallback(async () => {
    const next = await fetchNetworkPolicy()
    setView(next)
    setLoaded(true)
    if (next) {
      setMode(next.mode)
      setDenyText(next.denyHosts.join('\n'))
      setAllowText(next.allowHosts.join('\n'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /* 桥没接上：明确说一句，而不是白屏或显示一堆改不动的空框 */
  if (!ready) {
    return (
      <>
        <SectionTitle>网络策略</SectionTitle>
        <p className="px-2 py-1 text-2xs text-fg-tertiary">
          当前版本没接上这个桥（security:network），所以这里改不了 —— 其余设置不受影响，照常可以改。
        </p>
      </>
    )
  }

  /* 有没保存的改动 —— 按「名单解析后的结果」比，免得空行多少也算改动 */
  const dirty =
    !view ||
    mode !== view.mode ||
    parseHostLines(denyText).join('\n') !== view.denyHosts.join('\n') ||
    parseHostLines(allowText).join('\n') !== view.allowHosts.join('\n')

  async function save(): Promise<void> {
    setSaving(true)
    const result = await saveNetworkPolicy({
      mode,
      denyHosts: parseHostLines(denyText),
      allowHosts: parseHostLines(allowText),
    })
    if (!result.ok) {
      setSaving(false)
      showToast('error', '网络策略没保存成功', result.error ?? '主进程没给原因')
      return
    }
    await load()
    setSaving(false)
    showToast(
      'success',
      '网络策略已保存',
      `当前：${MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode}`,
    )
  }

  return (
    <>
      <SectionTitle>网络策略</SectionTitle>
      <p className="-mt-1 mb-1 px-1 text-2xs leading-relaxed text-fg-tertiary">
        命令行里的 curl、要联网的 MCP 服务器、应用自己发的请求 —— 这三个口子都先按这里的规则裁决。
      </p>

      <Row label="要联网时" hint="改完点下面的「保存」才生效。">
        <div className="flex flex-col gap-1">
          {MODE_OPTIONS.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-start gap-2 py-0.5">
              <input
                type="radio"
                name="networkMode"
                className="mt-1"
                checked={mode === option.value}
                onChange={() => setMode(option.value)}
              />
              <span>
                <span className="text-dense text-fg-primary">{option.label}</span>
                <span className="ml-1.5 text-2xs text-fg-tertiary">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </Row>

      <Row
        label="禁止名单"
        hint="一行一个，支持 *.example.com 通配。禁止优先于允许 —— 同时出现在两个名单里也拦。"
      >
        <HostInput
          value={denyText}
          onChange={setDenyText}
          placeholder={'api.example.com\n*.tracking.example.com'}
        />
      </Row>

      <Row
        label="允许名单"
        hint="一行一个，支持通配。必须命令里每个主机都在名单里才免问 —— 只中一个不放行。"
      >
        <HostInput
          value={allowText}
          onChange={setAllowText}
          placeholder={'registry.npmjs.org\n*.githubusercontent.com'}
        />
      </Row>

      <Row
        label="保存"
        hint={!loaded ? '正在读当前值…' : dirty ? '有没保存的改动。' : '当前值和磁盘上的一致。'}
      >
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            icon={<Save size={13} />}
            loading={saving}
            disabled={!dirty}
            onClick={() => void save()}
          >
            保存
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={12} />}
            disabled={saving}
            onClick={() => void load()}
          >
            重新读取
          </Button>
        </div>
      </Row>

      <SectionTitle>这个开关的边界</SectionTitle>
      <p className="-mt-1 mb-1 whitespace-pre-line rounded-base border border-line-subtle bg-bg-raised/40 px-3 py-2 text-2xs leading-relaxed text-fg-secondary">
        {view?.description ||
          '（内核这次没给出说明 —— 不知道它管不到什么之前，别把它当防火墙用。）'}
      </p>
      <p className="mb-2 px-1 text-2xs leading-relaxed text-fg-tertiary">
        上面这段由内核生成、原样显示，界面上不重写它 —— 重写一遍就会漂。
      </p>
    </>
  )
}

/** 主机名单输入：多行，一行一个（保存时 trim + 去空行，见 parseHostLines） */
function HostInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={3}
      spellCheck={false}
      placeholder={placeholder}
      className="w-full resize-y rounded-sm border border-line-subtle bg-bg-raised px-2 py-1.5 font-mono text-xs text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
    />
  )
}
