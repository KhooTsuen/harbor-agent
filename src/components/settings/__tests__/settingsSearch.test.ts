import { describe, expect, it } from 'vitest'
import { SETTINGS_INDEX, locationOf, searchSettings } from '../settingsSearch'
import { SETTINGS_TABS } from '../parts'
import type { SettingsTabId } from '../parts'

/* ══════════════════════════════════════════════════════════════
   P3 #20 · 设置搜索

   四条验收，逐条钉：
     · 常用词与专业词都能查到**真实存在**的选项
     · 结果带分类，定位正确（分类调整后仍对）
     · 无结果 / 清空 / 重复进入三种状态可理解
     · 搜索不改任何配置（本函数是纯函数，没有任何写入口）
   ══════════════════════════════════════════════════════════════ */

const tabOf = (id: SettingsTabId) => SETTINGS_TABS.find((item) => item.id === id)
const search = (q: string) => searchSettings(q, tabOf)

describe('P3 #20 · 设置搜索', () => {
  it('★ 常用词能查到：深色 → 外观页的配色', () => {
    const hits = search('深色')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.tab === 'appearance' && h.label === '配色')).toBe(true)
  })

  it('★ 专业词能查到：MCP / API Key / 权限', () => {
    expect(search('mcp').some((h) => h.tab === 'extension')).toBe(true)
    expect(search('api key').some((h) => h.label === 'API Key')).toBe(true)
    expect(search('权限').some((h) => h.tab === 'access')).toBe(true)
  })

  it('★ 不生成不存在的设置：每条结果都指向真实存在的页', () => {
    const valid = new Set(SETTINGS_TABS.map((t) => t.id))
    for (const entry of SETTINGS_INDEX) expect(valid.has(entry.tab)).toBe(true)
  })

  it('★ 页被删掉之后，指向它的结果不再出现（不留幽灵）', () => {
    /* 模拟「设置分类调整」：把 appearance 拿掉 */
    const pruned = (id: SettingsTabId) =>
      id === 'appearance' ? undefined : SETTINGS_TABS.find((item) => item.id === id)
    const hits = searchSettings('深色', pruned)
    expect(hits.some((h) => h.tab === 'appearance')).toBe(false)
  })

  it('空串不搜（不返回全表）', () => {
    expect(search('')).toEqual([])
    expect(search('   ')).toEqual([])
  })

  it('无结果时返回空数组，不是抛错也不是全表', () => {
    expect(search('这个词肯定没有')).toEqual([])
  })

  it('★ 精确命中排在前（搜「模型」先给「模型列表」）', () => {
    const hits = search('模型')
    expect(hits[0]?.label).toBe('模型列表')
  })

  it('大小写不敏感（Dark / dark 都命中）', () => {
    const lower = search('dark')
    const upper = search('DARK')
    expect(lower.length).toBeGreaterThan(0)
    expect(upper.map((h) => h.label)).toEqual(lower.map((h) => h.label))
  })

  it('★ 结果里带分类名，且简洁视图下会说明「在详细视图里」', () => {
    const entry = search('权限').find((h) => h.tab === 'access')!
    expect(locationOf(entry, tabOf, 'detailed')).toBe('权限与安全')
    expect(locationOf(entry, tabOf, 'simple')).toBe('权限与安全 · 在详细视图里')
  })

  it('★ 反复搜同一个词，结果顺序稳定（不跳来跳去）', () => {
    const first = search('保存').map((h) => h.label)
    const second = search('保存').map((h) => h.label)
    expect(second).toEqual(first)
  })

  it('★ 搜索是纯函数：不读 store、不写任何配置', () => {
    /* 函数签名里没有任何 setter / store 入口；这里再从行为上确认一遍：
       连搜十次，整张索引表一个字都没变 */
    const before = JSON.stringify(SETTINGS_INDEX)
    for (let i = 0; i < 10; i += 1) search(['深色', '备份', '权限', '模型'][i % 4])
    expect(JSON.stringify(SETTINGS_INDEX)).toBe(before)
  })
})
