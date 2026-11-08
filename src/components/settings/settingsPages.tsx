import type { ReactNode } from 'react'
import { AboutTab } from './tabs/AboutTab'
import { AppearanceTab } from './tabs/AppearanceTab'
import { MemoryTab } from './tabs/MemoryTab'
import { ExperienceTab } from './tabs/ExperienceTab'
import { ProfileTab } from './tabs/ProfileTab'
import { UsagePanel } from './usage/UsagePanel'
import { DataTab } from './tabs/DataTab'
import { GeneralTab } from './tabs/GeneralTab'
import { ConversationPanel } from './panels/ConversationPanel'
import { ContextPanel } from './panels/ContextPanel'
import { AccessPanel } from './panels/AccessPanel'
import { ExtensionPanel } from './panels/ExtensionPanel'
import { ModelsPanel } from './panels/ModelsPanel'
import type { SettingsTabId } from './settingsNav'

/* ══════════════════════════════════════════════════════════════
   13 页 → 组件 的装配表 —— **全项目只有这一处**

   ── 为什么单独一个文件 ─────────────────────────────────────────
   第一阶段会有**两个容器**同时存在：
     · `SettingsWorkspace`（主入口，主区域内的工作区）
     · `SettingsModal`（过渡兼容，仍在全局层里可用）
   两边各写一份 switch 就会漂 —— 加了页只改一边，另一边点了没反应。
   所以装配只在这里做，两个容器都调 `settingsPageOf(id)`。

   ── 页面成分没变 ──────────────────────────────────────────────
   本阶段只做「容器 + 导航」。每一页的内容仍是原来那些组件，
   **旧功能一个没丢**：13 页覆盖了原来 9 个标签页的全部内容，
   只是拆得更细（用量 / 数据分家、上下文从对话里独立出来）。
   ══════════════════════════════════════════════════════════════ */

/** 每一页渲染什么。不在表里的 id 返回 null（调用方兜底成首页） */
export function settingsPageOf(id: SettingsTabId): ReactNode {
  switch (id) {
    case 'profile':
      return <ProfileTab />
    case 'general':
      return <GeneralTab />
    case 'appearance':
      return <AppearanceTab />
    case 'models':
      return <ModelsPanel />
    case 'conversation':
      return <ConversationPanel />
    case 'context':
      return <ContextPanel />
    case 'access':
      return <AccessPanel />
    case 'extension':
      return <ExtensionPanel />
    case 'usage':
      return <UsagePanel />
    case 'data':
      return <DataTab />
    case 'memory':
      return <MemoryTab />
    case 'experience':
      return <ExperienceTab />
    case 'about':
      return <AboutTab />
    default:
      return null
  }
}
