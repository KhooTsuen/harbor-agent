import { useExtensionTabStore } from '@/stores/useExtensionTabStore'
import { ExtensionTabs } from './ExtensionTabs'
import { BrowserGroup } from './BrowserGroup'
import { SkillsGroup } from './SkillsGroup'
import { McpGroup } from './McpGroup'

/* ══════════════════════════════════════════════════════════════
   工具与扩展 = 让 Agent 多会点东西（从哪来 · 连没连上 · 怎么配）

   ── 从「一个长页面」改成「三个能力区」────────────────────────
   原来四块纵向平铺：链接策略 / 浏览器插件 / 技能 / MCP（含桥与项目测试）。
   MCP 那块最长，把技能挤到中间要滚很久；而这三块的**维护时刻**完全不同：
   插件装一次、技能偶尔加、MCP 接新服务时才来。

   ── 和「权限与安全」的分工（真机上容易混）────────────────────
     工具与扩展：**是什么 · 连没连上 · 怎么配**
     权限与安全：**允许它做什么 · 给过什么授权 · 做过什么**
   所以 MCP 的连接参数在右边（这一页），全局权限档在权限页；
   需要跨页找的时候给指路句子，不复制一份可编辑控件。

   ★ 双模型协作、定时任务已经分别归到「模型与服务商」「对话与任务」
     （第三阶段），这里不再留入口。
   ══════════════════════════════════════════════════════════════ */

export function ExtensionPanel(): React.ReactElement {
  const tab = useExtensionTabStore((s) => s.tab)

  return (
    <>
      <ExtensionTabs />
      {tab === 'browser' ? <BrowserGroup /> : null}
      {tab === 'skills' ? <SkillsGroup /> : null}
      {tab === 'mcp' ? <McpGroup /> : null}
    </>
  )
}
