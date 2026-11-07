import { MODES } from '@/constants'
import type { ThreadMode } from '@/types'
import { useConfigStore } from '@/stores/useConfigStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Select, Switch } from '@/components/ui/Field'
import { Row, SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
   对话行为 —— 新对话怎么开始、过程里自动做什么

   ── 第二阶段从「通用与快捷键」搬过来的两项 ────────────────────
   用户在原页面要同时分辨「这条改的是应用本身，还是对话本身」，
   而这两项的真实语义都是**对话层面**的：

     · 默认模式   新建对话时用哪个模式（pair / plan / execute / goal）
     · 自动起标题 第一轮结束后用模型起标题（对话流程里的一步）

   ★ 存储来源没变：默认模式在 `useSettingsStore`（本地偏好 + 回写
     general），自动起标题在 `config.general.autoTitle`（主进程配置）。
     只搬界面位置，不动任何默认值与保存路径 —— 老用户的值照旧生效。
   ══════════════════════════════════════════════════════════════ */

export function ConversationBehavior(): React.ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const config = useConfigStore((s) => s.config)
  const patchGeneral = useConfigStore((s) => s.patchGeneral)

  return (
    <>
      <SectionTitle hint="新建对话时的默认行为">新对话</SectionTitle>

      <Row
        label="默认模式"
        hint="新建对话时用哪个模式。会不会弹窗问你要确认，由「权限与安全」页的权限档位决定"
      >
        <Select
          value={settings.defaultMode}
          onChange={(v) => updateSettings({ defaultMode: v as ThreadMode })}
          options={MODES.map((m) => ({ value: m.id, label: `${m.label} —— ${m.hint}` }))}
        />
      </Row>

      <Row label="自动起标题" hint="第一轮结束后让它自己起个标题。关掉就用你第一句话截断当标题">
        <Switch
          checked={config?.general.autoTitle !== false}
          onChange={(v) => void patchGeneral({ autoTitle: v })}
          label="自动起标题"
        />
      </Row>
    </>
  )
}
