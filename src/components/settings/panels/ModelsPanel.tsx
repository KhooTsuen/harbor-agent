import { SectionTitle } from '../parts'
import { ProviderPanel, AssistantPanel } from '../ProviderPanel'

/* ══════════════════════════════════════════════════════════════
   模型 = 供应商（连哪儿）+ 助手参数（怎么答）

   原来这两个就在同一个标签里，抽成组件只是为了让 SettingsModal
   只剩「哪个标签显示哪块」，不再堆 JSX。
   ══════════════════════════════════════════════════════════════ */

export function ModelsPanel(): React.ReactElement {
  return (
    <>
      <SectionTitle>供应商</SectionTitle>
      <div className="py-2">
        <ProviderPanel />
      </div>

      <SectionTitle>助手参数</SectionTitle>
      <div className="py-2">
        <AssistantPanel />
      </div>
    </>
  )
}
