import { SkillsTab } from '../tabs/SkillsTab'
import { McpTab } from '../tabs/McpTab'
import { SchedulesPanel } from './SchedulesPanel'

/* ══════════════════════════════════════════════════════════════
   扩展 = 技能 + MCP + 定时任务

   三者都是「让 Agent 多会点东西」，只是来源不同：
     技能     本地文件（我教它怎么做这类事）
     MCP      外部进程（接别的工具/服务）
     定时任务  不靠人开口（到点自己跑一次）
   原来分成「技能」和「扩展」两个标签，名字还容易混。

   定时任务排在最后：它的授权上限是个要认真读的东西，
   前面两块是「多会点技能」，它是「我不在场时它还能干什么」。
   ══════════════════════════════════════════════════════════════ */

export function ExtensionPanel(): React.ReactElement {
  return (
    <>
      <SkillsTab />
      <div>
        <McpTab />
      </div>
      <SchedulesPanel />
    </>
  )
}
