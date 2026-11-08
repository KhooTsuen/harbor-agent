import { create } from 'zustand'

/* ══════════════════════════════════════════════════════════════
   「权限与安全」页内的四个分组

   ── 为什么状态住在组件外 ───────────────────────────────────────
   和 `useModelsTabStore` 同一个理由：切到别的设置页再回来，
   应该还在刚才那个分组，而不是跳回第一组。

   ── 四组按「用户来这儿干什么」分 ───────────────────────────────
     · policy      我允许它做什么（档位 / 文件 / 命令 / 网络）
     · protection  我的数据怎么被保护（会话加密 / 凭证 / 敏感文件）
     · audit       它实际做了什么、我还能收回什么
     · advanced    风险试算与不可逆操作 —— 平时不看，出事才来

   ★ 最后那组不是「藏起来」：导航里一直看得见，只是不占第一屏。
     页面折叠是交互设计，**不是安全边界**（判据始终在内核里）。
   ══════════════════════════════════════════════════════════════ */

export const ACCESS_TABS = ['policy', 'protection', 'audit', 'advanced'] as const

export type AccessTab = (typeof ACCESS_TABS)[number]

interface AccessTabState {
  tab: AccessTab
  setTab: (tab: AccessTab) => void
}

export const useAccessTabStore = create<AccessTabState>((set) => ({
  tab: 'policy',
  setTab: (tab) => set({ tab }),
}))

export function isAccessTab(value: unknown): value is AccessTab {
  return typeof value === 'string' && (ACCESS_TABS as readonly string[]).includes(value)
}
