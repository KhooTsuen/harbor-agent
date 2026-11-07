import { SectionTitle } from '../parts'
import { ScenesTab } from '../tabs/ScenesTab'
import { ImageSaveTab } from '../tabs/ImageSaveTab'
import { DownloadSaveTab } from '../tabs/DownloadSaveTab'
import { ConversationExperienceTab } from '../tabs/ConversationExperienceTab'

/* ══════════════════════════════════════════════════════════════
   对话与任务 = 对话怎么进行

   ★ 第一阶段 13 页重排后，这一页只剩「过程」相关的：
       · 对话体验（回车发送 / 默认模式 / 打字机 / 结果摘要）
       · 场景模板（起标题、翻译、建议这些固定用途的参数）
       · 生图与下载存到哪

   「默认工作目录 / 项目上下文 / 本次会话」搬去了 `ContextPanel`
   （同一根轴上的三级覆盖）。这里再留一份就会出现两处真源 ——
   `phase2Joint.test` 明确钉着「工具页不许再有工作目录」，同一道理。
   ══════════════════════════════════════════════════════════════ */

export function ConversationPanel(): React.ReactElement {
  return (
    <>
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
    </>
  )
}
