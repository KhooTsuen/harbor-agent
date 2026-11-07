import { SETTINGS_INDEX_BASIC } from './settingsIndexBasic'
import { SETTINGS_INDEX_REST } from './settingsIndexRest'

/* ══════════════════════════════════════════════════════════════
   P3 #20：设置搜索的**索引**（统一出口）

   ── 为什么是一张手写的表，而不是去扫 DOM ──────────────────────
   扫 DOM 只能搜到当前页（其余标签页没挂载），且扫到的是渲染后文案（搜「深色」时
   界面写的可能是「配色」）。这里维护「设置项 → 所在页」：① 搜得到没打开的页里的项；
   ② 结果里显示它在哪一页；③ 点结果能定位过去。

   ── 维护规矩 ─────────────────────────────────────────────────
   加一个用户看得见的设置项，就**在对应那一半里加一条**。只收「用户会搜的叫法」，
   不收实现细节（内部字段名搜它没意义）。★ 只索引**真实存在**的设置项 ——
   每一项都指向 `SETTINGS_NAV` 里真有的页（不生成不存在的设置）。

   ── 为什么拆成三个文件（2026-11-08）────────────────────────────
   13 页之后条目变多，数据表被 prettier 逐条展开到 314 行（红线 300）。
   数据占大头、压注释腾不出空间，所以按导航分组拆成两半：
     · `settingsIndexBasic.ts` —— 基础 + 智能体与模型
     · `settingsIndexRest.ts`  —— 能力与安全 + 数据与知识 + 系统
   条目形状在 `settingsIndexTypes.ts`。**外部只 import 这个文件**。
   ══════════════════════════════════════════════════════════════ */

export type { SettingsEntry } from './settingsIndexTypes'

/** 设置项索引（按导航顺序拼起来；数据在两个 settingsIndex*.ts 里） */
export const SETTINGS_INDEX: readonly import('./settingsIndexTypes').SettingsEntry[] = [
  ...SETTINGS_INDEX_BASIC,
  ...SETTINGS_INDEX_REST,
]
