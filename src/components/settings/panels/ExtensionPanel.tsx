import { SkillsTab } from '../tabs/SkillsTab'
import { McpTab } from '../tabs/McpTab'

/* ══════════════════════════════════════════════════════════════
   扩展 = 技能 + MCP

   两者都是「让 Agent 多会点东西」，只是来源不同：
     技能   本地文件（我教它怎么做这类事）
     MCP    外部进程（接别的工具/服务）
   原来分成「技能」和「扩展」两个标签，名字还容易混。
   ══════════════════════════════════════════════════════════════ */

export function ExtensionPanel(): React.ReactElement {
  return (
    <>
      <SkillsTab />
      <div>
        <McpTab />
      </div>
    </>
  )
}
