import { useAppStore } from '@/stores/useAppStore'
import { Row, SectionTitle } from '../parts'

export function ThreadSettingsTab() {
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))
  const update = useAppStore((s) => s.updateThreadSettings)
  if (!thread) return <p className="p-3 text-2xs text-fg-tertiary">没有打开的会话。</p>
  const settings = thread.settings ?? {}
  const toggle = (key: keyof typeof settings) =>
    update(thread.id, { [key]: settings[key] === false })
  return (
    <div className="py-1">
      <SectionTitle>本次会话</SectionTitle>
      <Row label="回答深度" hint="只影响当前会话，不修改全局默认">
        <select
          value={settings.responseDepth ?? 'standard'}
          onChange={(e) =>
            update(thread.id, {
              responseDepth: e.target.value as 'concise' | 'standard' | 'detailed' | 'deep',
            })
          }
          className="rounded-sm border border-line-subtle bg-bg-raised px-2 py-1 text-xs text-fg-primary"
        >
          <option value="concise">简洁</option>
          <option value="standard">标准</option>
          <option value="detailed">详细</option>
          <option value="deep">深入</option>
        </select>
      </Row>
      {(
        [
          ['allowNetwork', '联网'],
          ['allowTools', '工具'],
          ['allowWrite', '文件写入'],
          ['useMemory', '长期记忆'],
        ] as const
      ).map(([key, label]) => (
        <Row key={key} label={label} hint="点击切换本会话覆盖">
          <label className="flex items-center gap-2 text-xs text-fg-primary">
            <input type="checkbox" checked={settings[key] !== false} onChange={() => toggle(key)} />
            允许
          </label>
        </Row>
      ))}
      <Row label="临时对话" hint="临时对话不会写入长期记忆">
        <label className="flex items-center gap-2 text-xs text-fg-primary">
          <input type="checkbox" checked={thread.temporary === true} readOnly />
          当前状态：{thread.temporary ? '是' : '否'}（使用 /temporary 开启）
        </label>
      </Row>
    </div>
  )
}
