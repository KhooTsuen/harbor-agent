import { create } from 'zustand'

/* ══════════════════════════════════════════════════════════════
   「工具与扩展」页内的三个能力区域

   ── 为什么是这三个 ────────────────────────────────────────────
   这一页管的是「Agent 多会点东西」，来源只有三种：
     · browser  浏览器扩展（Edge 侧边栏 / Native Host）
     · skills   本地技能文件（我教它怎么做这类事）
     · mcp      外部进程（接别的工具 / 服务）

   原来三块纵向平铺，MCP 那块最长（服务器列表 + 预设 + Codex 桥 + 项目测试），
   把「技能」挤到中间要滚很久。分区之后每块自己一屏。

   ★ 和「权限与安全」用同一套标签交互，但**分组内容不一样** ——
     那页按「什么时候会发生」分，这页按「能力从哪来」分。
     不为了统一而强行套同一个结构。
   ══════════════════════════════════════════════════════════════ */

export const EXTENSION_TABS = ['browser', 'skills', 'mcp'] as const

export type ExtensionTab = (typeof EXTENSION_TABS)[number]

interface ExtensionTabState {
  tab: ExtensionTab
  setTab: (tab: ExtensionTab) => void
}

export const useExtensionTabStore = create<ExtensionTabState>((set) => ({
  tab: 'browser',
  setTab: (tab) => set({ tab }),
}))

export function isExtensionTab(value: unknown): value is ExtensionTab {
  return typeof value === 'string' && (EXTENSION_TABS as readonly string[]).includes(value)
}
