import type { SettingsTabId } from './parts'
import { SETTINGS_INDEX, type SettingsEntry } from './settingsIndex'

/* ══════════════════════════════════════════════════════════════
   P3 #20：设置搜索的匹配与定位

   索引数据在 `settingsIndex.ts`（40+ 条，会随设置项增长）；
   这里只有算法 —— 两件事分开维护，各自都好读。

   ★ 匹配规则刻意保守（顺序即优先级）：
     ① 项名完全等于关键词 → 最相关
     ② 项名包含关键词
     ③ 关键词 / 说明里包含 → 其次
     这样搜「模型」先给「模型列表」，而不是把所有提到模型的项平铺一遍。

   ★ 三条「不生成不存在的设置」的落地：
     · 只从索引出结果
     · 页面被删掉的项不算命中（`tabOf` 查不到就跳过）
     · 结果里带分类名（用户点之前就知道会跳到哪）

   ★ 纯函数：不读 store、不写任何配置 ——
     文档验收要求「搜索与视图切换不更改配置值、权限或默认模式」。
   ══════════════════════════════════════════════════════════════ */

export type { SettingsEntry }
export { SETTINGS_INDEX }

/** 参与模糊匹配的文本池：说明 + 关键词 */
function poolOf(entry: SettingsEntry): string {
  return [entry.hint, ...entry.keywords].join(' ').toLowerCase()
}

/**
 * 搜设置。
 *
 * @param query 用户输入（空串 = 不搜，返回空数组）
 * @param tabOf 查「这一页还在吗」—— 页面被删掉的项不算命中
 */
export function searchSettings(
  query: string,
  tabOf: (id: SettingsTabId) => { label: string } | undefined,
): SettingsEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const hit: { entry: SettingsEntry; score: number }[] = []
  for (const entry of SETTINGS_INDEX) {
    /* 页面不在了就跳过 —— 绝不返回一条「点进去什么都没有」的结果 */
    if (!tabOf(entry.tab)) continue
    const label = entry.label.toLowerCase()
    const score = label === q ? 0 : label.includes(q) ? 1 : poolOf(entry).includes(q) ? 2 : -1
    if (score >= 0) hit.push({ entry, score })
  }
  /* 同分时保持索引顺序（稳定排序，用户第二次搜同一词结果不会换位置） */
  return hit.sort((a, b) => a.score - b.score).map((item) => item.entry)
}

/**
 * 结果里那句「在哪儿」。
 *
 * 简洁视图下搜到被收起的专业页时，必须**说明它在哪、怎么进去** ——
 * 否则用户点了一个结果却看不到那一页，会以为搜索坏了。
 */
export function locationOf(
  entry: SettingsEntry,
  tabOf: (id: SettingsTabId) => { label: string; detailedOnly?: boolean } | undefined,
  view: 'simple' | 'detailed',
): string {
  const tab = tabOf(entry.tab)
  const name = tab?.label ?? entry.tab
  if (view === 'simple' && tab?.detailedOnly) return `${name} · 在详细视图里`
  return name
}
