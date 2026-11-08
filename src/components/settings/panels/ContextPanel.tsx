import { SectionTitle } from '../parts'
import { ProjectContextTab } from '../tabs/ProjectContextTab'
import { ThreadSettingsTab } from '../tabs/ThreadSettingsTab'
import { WorkdirRow } from '../providers/WorkdirRow'
import { CompactThresholdRow } from '../tabs/CompactThresholdRow'

/* ══════════════════════════════════════════════════════════════
   上下文与项目 = 它开工时看什么

   三样东西说的是同一件事的三个层级，自上而下：
     全局默认   没挂目录的对话在哪开工（WorkdirRow）
     项目覆盖   只对当前项目生效的额外说明
     对话覆盖   只对当前这条对话生效的临时设置

   ★ 工作目录从「对话与任务」搬到这里（第一阶段 13 页重排）：
     它本来就不是「对话怎么进行」的问题，而是「在哪儿干活」——
     和项目上下文/本次会话是同一根轴上的三级。
     `ConversationPanel` 里不再有它，避免出现两处真源。
   ══════════════════════════════════════════════════════════════ */

export function ContextPanel(): React.ReactElement {
  return (
    <>
      <div className="flex flex-col gap-2 pt-1">
        <SectionTitle hint="影响所有对话；下面两项可以按项目 / 按对话覆盖它">全局默认</SectionTitle>
        <WorkdirRow />
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle hint="用掉窗口多少比例时压缩；两档都是全局默认">压缩</SectionTitle>
        <CompactThresholdRow />

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
