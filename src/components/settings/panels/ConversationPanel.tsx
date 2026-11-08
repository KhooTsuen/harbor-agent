import { ConversationExperienceTab } from '../tabs/ConversationExperienceTab'
import { ConversationBehavior } from './ConversationBehavior'
import { AssistantPersona } from '../providers/AssistantPersona'
import { SchedulesPanel } from './SchedulesPanel'

/* ══════════════════════════════════════════════════════════════
   对话与任务 = 对话怎么进行

   顺序按「什么时候会遇到」排：新对话的默认 → 过程中看什么 →
   固定用途的场景参数 → 产物存哪。

   ★ 第一阶段 13 页重排后，工作目录 / 项目上下文 / 本次会话搬去了
     `ContextPanel`（同一根轴上的三级覆盖），这里不再留一份。
   ★ 第二阶段，「默认模式 / 自动起标题」从「通用与快捷键」搬进来 ——
     它们改的本来就是对话行为，不是应用本身。
   ══════════════════════════════════════════════════════════════ */

export function ConversationPanel(): React.ReactElement {
  return (
    <>
      <ConversationBehavior />

      <ConversationExperienceTab />

      <AssistantPersona />

      {/* 定时任务：标题由 SchedulesPanel 自己带（它内部两个分支各有一句），这里不再包一层 */}
      <SchedulesPanel />
    </>
  )
}
