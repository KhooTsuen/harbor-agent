import { Row, SectionTitle } from '../parts'
import { useSettingsStore } from '@/stores/useSettingsStore'

/* ══════════════════════════════════════════════════════════════
   对话体验（P2 #30 + #1 的入口）

   两件事放一起，因为它们是同一类选择：**你想看到多少**。
     · 结果摘要 —— 每轮结束后要不要多一张「成了没成」的卡（默认关）
     · 设置视图 —— 设置页只列常用项，还是全量展开（默认简洁）

   两个都写进 `useSettingsStore`（localStorage + 回写主进程 general），
   和别的设置同一套保存机制 —— 不另起一套。
   ══════════════════════════════════════════════════════════════ */

export function ConversationExperienceTab(): React.ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.updateSettings)

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle hint="只影响显示，不改变 Agent 的行为">对话体验</SectionTitle>

      <Row
        label="每轮结束显示结果摘要"
        hint="关闭时不生成摘要卡。开启后显示完成/失败/停下、改动文件和检查结论 —— 依据任务台账，不是模型自述"
      >
        <label className="flex items-center gap-2 text-xs text-fg-primary">
          <input
            type="checkbox"
            checked={settings.taskSummary === true}
            onChange={(e) => update({ taskSummary: e.target.checked })}
            aria-label="每轮结束显示结果摘要"
          />
          {settings.taskSummary ? '已开启' : '已关闭（默认）'}
        </label>
      </Row>

      <Row
        label="设置页视图"
        hint="简洁视图只列常用项；仍在生效的专业设置会在顶部点名，随时可切到详细视图调整"
      >
        <select
          value={settings.settingsView === 'detailed' ? 'detailed' : 'simple'}
          onChange={(e) =>
            update({ settingsView: e.target.value === 'detailed' ? 'detailed' : 'simple' })
          }
          aria-label="设置页视图"
          className="rounded-sm border border-line-subtle bg-bg-input px-2 py-1 text-xs text-fg-primary"
        >
          <option value="simple">简洁</option>
          <option value="detailed">详细</option>
        </select>
      </Row>
    </div>
  )
}
