import { ProviderPanel, ToolsPanel } from '../ProviderPanel'
import { ModelParamsPanel } from '../providers/ModelParamsPanel'
import { AssistantSwitches } from '../providers/AssistantSwitches'
import { CollabPanel } from '../CollabPanel'
import { ScenesPanel } from './ScenesPanel'
import { ModelsTabs } from '../models/ModelsTabs'
import { useModelsTabStore } from '@/stores/useModelsTabStore'
import { SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
    模型与服务商 —— 四个主标签的容器

    ── 第三阶段：从「一页三块」变成「四标签」──────────────────────
    原来这一页是「供应商 + 助手参数」两大块，而真正和模型有关的
    场景模型、路由、失败回退、协作、Agent 行为开关全散在别的页里。
    现在集中到四个标签：

      服务商       连接、Key、能力、连接测试、Codex CLI
      模型与场景   默认模型 / 采样参数 / 八个场景 / 自动路由 / 失败处理
      运行策略     七个 Agent 行为开关（含重操作时长阈值）
      双模型协作   开关 + 后端现状 + 缺什么

    ── 每个配置只有一个入口 ──────────────────────────────────────
    搬进来之后旧页面里那些挂载必须同时摘掉，否则就是「两处都能改同一份
    配置」。第一阶段踩过一次（两处都用 settingsOpen → 界面出现两遍），
    第二阶段又踩过一次（ShortcutsTab 被挂两次）。所以这一轮**先搬、
    立刻删旧挂载**，并有测试钉着「每个组件只出现一次」。

    ── 工具权限不在这里 ──────────────────────────────────────────
    `ToolsPanel`（权限档位 / 命令超时）属于「权限与安全」，仍在那边 ——
    它不是模型配置。
    ══════════════════════════════════════════════════════════════ */

export function ModelsPanel(): React.ReactElement {
  const tab = useModelsTabStore((s) => s.tab)

  return (
    <div className="flex flex-col gap-2">
      <ModelsTabs />

      {tab === 'providers' ? (
        <div className="flex flex-col gap-3">
          <SectionTitle hint="支持任何 OpenAI 兼容接口；Codex CLI 走本机命令行">
            已配置的服务商
          </SectionTitle>
          <ProviderPanel />
        </div>
      ) : null}

      {tab === 'scenes' ? (
        <>
          <ModelParamsPanel />
          <ScenesPanel />
        </>
      ) : null}

      {tab === 'policy' ? (
        <>
          <SectionTitle hint="每个开关下面那行小字写的是按下去到底会发生什么">
            Agent 行为
          </SectionTitle>
          <div className="flex flex-col gap-3">
            <AssistantSwitches />
          </div>
        </>
      ) : null}

      {tab === 'collab' ? <CollabPanel /> : null}
    </div>
  )
}

/* 权限档位仍在「权限与安全」页 —— 这里只是把它转出去，
   让老代码（AccessPanel）的引用路径不用改。 */
export { ToolsPanel }
