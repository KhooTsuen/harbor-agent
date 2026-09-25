import { SectionTitle } from '../parts'
import { ScenesTab } from '../tabs/ScenesTab'
import { ImageSaveTab } from '../tabs/ImageSaveTab'
import { ThreadSettingsTab } from '../tabs/ThreadSettingsTab'
import { ProjectContextTab } from '../tabs/ProjectContextTab'

/* ══════════════════════════════════════════════════════════════
   对话 = 全局默认（模型/路由/预算）+ 本次会话 + 项目上下文

   合在一起的道理：这三样说的是**同一件事的三个层级** ——
     全局默认 → 这条会话覆盖 → 这个项目覆盖
   原来是三个标签，用户得自己在脑子里拼出这个关系。

   顺序也按这个层级自上而下：先全局、再本项目、最后本次会话。
   ══════════════════════════════════════════════════════════════ */

export function ConversationPanel(): React.ReactElement {
  return (
    <>
      <ScenesTab />

      <div className="py-2">
        <SectionTitle>生图</SectionTitle>
        <ImageSaveTab />
      </div>

      <div>
        <SectionTitle>项目上下文</SectionTitle>
        <p className="py-1 text-dense leading-relaxed text-fg-tertiary">
          下面两项是**覆盖**：只在当前项目 / 当前这条对话里生效，不动上面的全局默认。
        </p>
        <ProjectContextTab />
        <div>
          <ThreadSettingsTab />
        </div>
      </div>
    </>
  )
}
