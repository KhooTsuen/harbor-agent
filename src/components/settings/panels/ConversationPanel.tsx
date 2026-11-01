import { SectionTitle } from '../parts'
import { ScenesTab } from '../tabs/ScenesTab'
import { ImageSaveTab } from '../tabs/ImageSaveTab'
import { DownloadSaveTab } from '../tabs/DownloadSaveTab'
import { ThreadSettingsTab } from '../tabs/ThreadSettingsTab'
import { ProjectContextTab } from '../tabs/ProjectContextTab'
import { ConversationExperienceTab } from '../tabs/ConversationExperienceTab'
import { WorkdirRow } from '../providers/WorkdirRow'

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
      {/*
        ★ 第二阶段：默认工作目录搬到这里的最上面（原来在「设置 → 工具」）。
          它不是工具参数，而是「没挂目录的对话在哪儿开工」—— 对话层面的全局默认。
          标题写清「全局默认」，免得和下面的「项目上下文 / 本次会话」混起来。
      */}
      <div className="flex flex-col gap-2 pt-1">
        {/*
          范围说在前面：这一块下面所有东西（工作目录 / 对话体验 / 模型与提示词 /
          场景与预算）都是**全局**的 —— 改一次，所有对话都受影响。
          和「项目上下文」那两块的区别必须写出来，否则用户分不清「我改的这个
          是只对这条对话生效，还是全都变了」（第二阶段明确要求）。
        */}
        <SectionTitle hint="影响所有对话；下面「项目上下文」里的两项可以按项目 / 按对话覆盖它">
          全局默认
        </SectionTitle>
        <WorkdirRow />
      </div>

      <ConversationExperienceTab />

      <ScenesTab />

      <div className="flex flex-col gap-2 py-2">
        <SectionTitle>生图</SectionTitle>
        <ImageSaveTab />
      </div>

      <div className="flex flex-col gap-2 py-2">
        <SectionTitle>下载</SectionTitle>
        <DownloadSaveTab />
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle>项目上下文</SectionTitle>
        <p className="text-dense leading-relaxed text-fg-tertiary">
          下面两项是<strong className="font-semibold">覆盖</strong>
          ：只在当前项目 / 当前这条对话里生效，不动上面的全局默认。
        </p>
        <ProjectContextTab />
        <ThreadSettingsTab />
      </div>
    </>
  )
}
