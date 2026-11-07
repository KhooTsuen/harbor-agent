import { Select } from '@/components/ui/Field'
import { useConfigStore } from '@/stores/useConfigStore'
import { Row, SectionTitle } from '../parts'
import { BrowserExtCard } from '../tabs/BrowserExtCard'
import { SkillsTab } from '../tabs/SkillsTab'
import { McpTab } from '../tabs/McpTab'
import { SchedulesPanel } from './SchedulesPanel'

/* ══════════════════════════════════════════════════════════════
   工具与扩展 = 让 Agent 多会点东西

   五块按「来源」排，也按「离你由近到远」排：
     浏览器链接  Agent 打开网页时的放行策略（这是权限，不是插件）
     浏览器插件  Edge 侧边栏（读你正在看的网页）
     技能        本地文件（我教它怎么做这类事）
     MCP         外部进程（接别的工具/服务）
     定时任务    不靠人开口（到点自己跑一次）

   ★ 第二阶段：「网页里的链接」从「通用与快捷键」搬到这里。
     它原来和「回车发送」摆在一起，但它改的是 **Agent 能不能打开某个地址**，
     属于能力与放行，不是应用本身的输入习惯。配置键没变
     （`config.general.browserNavigation`），只是换了编辑位置。

   定时任务排最后：它的授权上限是个要认真读的东西 ——
   前面几块是「多会点技能」，它是「我不在场时它还能干什么」。
   ══════════════════════════════════════════════════════════════ */

export function ExtensionPanel(): React.ReactElement {
  const config = useConfigStore((s) => s.config)
  const patchGeneral = useConfigStore((s) => s.patchGeneral)

  return (
    <>
      <SectionTitle hint="Agent 在网页里点链接时怎么处理">浏览与插件</SectionTitle>

      <Row
        label="网页里的链接"
        hint="Agent 打开网页时的放行策略：每次先问你 / 直接放行 http(s) / 只允许打开空白页"
      >
        <Select
          value={config?.general.browserNavigation ?? 'ask'}
          onChange={(v) => void patchGeneral({ browserNavigation: v as 'ask' | 'allow' | 'block' })}
          options={[
            { value: 'ask', label: '每次先问我' },
            { value: 'allow', label: '直接放行' },
            { value: 'block', label: '不允许打开网页' },
          ]}
        />
      </Row>

      <BrowserExtCard />

      <SkillsTab />

      <div>
        <McpTab />
      </div>

      <SchedulesPanel />
    </>
  )
}
