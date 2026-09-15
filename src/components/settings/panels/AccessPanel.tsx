import { SectionTitle } from '../parts'
import { ToolsPanel } from '../ProviderPanel'
import { SecurityTab } from '../tabs/SecurityTab'
import { SearchPanel } from '../tabs/SearchPanel'

/* ══════════════════════════════════════════════════════════════
   权限与安全 = Agent 能碰什么

   原来分成「工具」和「安全」两个标签 —— 但权限三档在「工具」里、
   文件访问范围在「安全」里，**说的是一件事**，用户得两边找。

   合起来之后这一页就是三条轴，很好记：
     文件（工作目录 + 文件访问范围）
     网络（联网搜索 + 出口）
     命令（Shell 风险策略）
   最后是「留下了什么痕」（审计日志）和「密钥放哪」。
   ══════════════════════════════════════════════════════════════ */

export function AccessPanel(): React.ReactElement {
  return (
    <>
      <ToolsPanel />

      <SectionTitle>联网</SectionTitle>
      <div className="py-3">
        <SearchPanel />
      </div>

      <div>
        <SecurityTab />
      </div>
    </>
  )
}
