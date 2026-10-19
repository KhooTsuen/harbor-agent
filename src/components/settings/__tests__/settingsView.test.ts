import { describe, expect, it } from 'vitest'
import { SETTINGS_TABS, hiddenTabsOf, visibleTabsOf } from '../parts'

/* ══════════════════════════════════════════════════════════════
   P2 #1：简洁 / 详细设置视图

   三条验收钉在这里：
     · 简洁视图**不丢**任何设置的入口（被收起的页可经详细视图进入）
     · 被收起来的页会被「点名」（隐藏但仍生效，不能让用户以为没启用）
     · 用户从别的入口被指到某一页时，那一页必须仍然出现
   ══════════════════════════════════════════════════════════════ */

describe('P2 #1 设置视图过滤', () => {
  it('简洁视图隐藏 detailedOnly 的页，其余一个不少', () => {
    const simple = visibleTabsOf(SETTINGS_TABS, 'simple', 'general')
    const expected = SETTINGS_TABS.filter((t) => !t.detailedOnly).map((t) => t.id)
    expect(simple.map((t) => t.id)).toEqual(expected)
  })

  it('详细视图 = 全部页（不丢东西）', () => {
    expect(visibleTabsOf(SETTINGS_TABS, 'detailed', 'general')).toHaveLength(SETTINGS_TABS.length)
  })

  it('被指到详细页时，那一页在简洁视图里仍然出现', () => {
    const simple = visibleTabsOf(SETTINGS_TABS, 'simple', 'access')
    expect(simple.map((t) => t.id)).toContain('access')
  })

  it('隐藏页清单只在简洁视图里非空（用于「仍在生效」提示）', () => {
    const hidden = hiddenTabsOf(SETTINGS_TABS, 'simple')
    expect(hidden.length).toBeGreaterThan(0)
    expect(hidden.every((t) => t.detailedOnly === true)).toBe(true)
    expect(hiddenTabsOf(SETTINGS_TABS, 'detailed')).toEqual([])
  })

  it('简洁视图 + 详细视图合起来覆盖全部页（没有设置被彻底藏掉）', () => {
    const simple = new Set(visibleTabsOf(SETTINGS_TABS, 'simple', 'general').map((t) => t.id))
    const hidden = new Set(hiddenTabsOf(SETTINGS_TABS, 'simple').map((t) => t.id))
    const all = new Set([...simple, ...hidden])
    expect(all.size).toBe(SETTINGS_TABS.length)
  })

  it('标签 id 不重复（过滤器不会因重复 id 漏页）', () => {
    const ids = SETTINGS_TABS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
