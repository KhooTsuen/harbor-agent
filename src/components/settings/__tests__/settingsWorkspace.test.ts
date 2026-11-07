import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SETTINGS_GROUPS,
  SETTINGS_HOME,
  SETTINGS_IDS,
  SETTINGS_NAV,
  isSettingsTabId,
} from '../settingsNav'
import { SETTINGS_INDEX } from '../settingsIndex'

/* ══════════════════════════════════════════════════════════════
   设置工作区 · 第一阶段（骨架与导航）

   这一组钉的是**结构与接线**，不钉长相：
     · 13 页都在、5 组有序、id 唯一
     · 每页都有标题与说明（工作区不是空白页）
     · 搜索索引不指向不存在的页
     · 「记住上次的页」有持久化字段、脏值有回落
     · 两个容器（工作区 / 过渡弹窗）用**同一张**装配表

   真机能不能点、长得对不对，靠 `npm run shot:electron -- --dev`，不在这里。
   ══════════════════════════════════════════════════════════════ */

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

/** 本阶段确认的 13 页（用户给的清单，逐条对上） */
const EXPECTED_13 = [
  'profile',
  'general',
  'appearance',
  'models',
  'conversation',
  'context',
  'access',
  'extension',
  'usage',
  'data',
  'memory',
  'experience',
  'about',
] as const

describe('设置工作区 / ① 13 页导航齐全', () => {
  it('★★ 正好 13 页，且与确认的信息架构逐条对上', () => {
    expect(SETTINGS_NAV.map((t) => t.id)).toEqual([...EXPECTED_13])
  })

  it('★ 5 个分组，顺序固定', () => {
    expect([...SETTINGS_GROUPS]).toEqual([
      '基础',
      '智能体与模型',
      '能力与安全',
      '数据与知识',
      '系统',
    ])
  })

  it('★ 每页都落在某个分组里（没有游离页）', () => {
    const groups = new Set<string>(SETTINGS_GROUPS)
    for (const tab of SETTINGS_NAV) {
      expect(tab.group && groups.has(tab.group), `${tab.id} 的 group=${tab.group}`).toBe(true)
    }
  })

  it('★ 每个分组至少有一页（不出现空标题）', () => {
    for (const group of SETTINGS_GROUPS) {
      expect(SETTINGS_NAV.filter((t) => t.group === group).length).toBeGreaterThan(0)
    }
  })

  it('页 id 唯一（导航不会因为重复 id 漏页）', () => {
    expect(new Set(SETTINGS_IDS).size).toBe(SETTINGS_IDS.length)
  })

  it('★ 每页都有标题与说明（工作区不能是空白页）', () => {
    for (const tab of SETTINGS_NAV) {
      expect(tab.label.trim().length, `${tab.id} 缺标题`).toBeGreaterThan(0)
      expect(tab.blurb.trim().length, `${tab.id} 缺说明`).toBeGreaterThan(0)
    }
  })
})

describe('设置工作区 / ② 首页与脏值回落', () => {
  it('★ 首页是合法页 id', () => {
    expect(isSettingsTabId(SETTINGS_HOME)).toBe(true)
  })

  it('★★ 老配置里的脏值（已删页 / 乱写）不认', () => {
    /* 第一阶段把 datausage 拆成了 usage + data —— 老值必须被拒 */
    expect(isSettingsTabId('datausage')).toBe(false)
    expect(isSettingsTabId('')).toBe(false)
    expect(isSettingsTabId(null)).toBe(false)
    expect(isSettingsTabId(42)).toBe(false)
    expect(isSettingsTabId('不存在的页')).toBe(false)
  })

  it('★ 「记住上次的页」有持久化字段，且默认值是合法页', () => {
    const store = read('src/stores/useSettingsStore.ts')
    expect(store).toContain('lastSettingsTab')
    const types = read('src/types/settings.ts')
    expect(types).toContain('lastSettingsTab')
  })
})

describe('设置工作区 / ③ 搜索索引与新导航一致', () => {
  it('★★ 索引里没有指向不存在页的条目（不留幽灵结果）', () => {
    const valid = new Set<string>(SETTINGS_IDS)
    const ghosts = SETTINGS_INDEX.filter((e) => !valid.has(e.tab))
    expect(ghosts.map((e) => `${e.tab}:${e.label}`)).toEqual([])
  })

  it('★ 拆分后的两页各有条目（用量 / 数据都搜得到）', () => {
    expect(SETTINGS_INDEX.some((e) => e.tab === 'usage')).toBe(true)
    expect(SETTINGS_INDEX.some((e) => e.tab === 'data')).toBe(true)
  })

  it('★ 常用词仍然搜得到真实存在的项（深色 → 外观）', () => {
    const hits = SETTINGS_INDEX.filter((e) => e.keywords.some((k) => k.includes('深色')))
    expect(hits.some((h) => h.tab === 'appearance')).toBe(true)
  })
})

describe('设置工作区 / ④ 两个容器共用同一张装配表', () => {
  it('★★ 工作区与弹窗都用 settingsPageOf（不各写一份 switch）', () => {
    const ws = strip(read('src/components/settings/SettingsWorkspace.tsx'))
    const modal = strip(read('src/components/settings/SettingsModal.tsx'))
    expect(ws).toContain('settingsPageOf(')
    expect(modal).toContain('settingsPageOf(')
  })

  it('★ 装配表覆盖全部 13 页（没有落到 default 的）', () => {
    const pages = strip(read('src/components/settings/settingsPages.tsx'))
    for (const id of EXPECTED_13) {
      expect(pages, `装配表缺 ${id}`).toContain(`case '${id}':`)
    }
  })

  it('★ 两个容器共用同一个导航组件（13 项不会一边有一边没有）', () => {
    const ws = strip(read('src/components/settings/SettingsWorkspace.tsx'))
    const modal = strip(read('src/components/settings/SettingsModal.tsx'))
    expect(ws).toContain('<SettingsNavRail')
    expect(modal).toContain('<SettingsNavRail')
  })

  it('★ 导航不做简洁/详细过滤（13 页始终都能找到）', () => {
    const rail = strip(read('src/components/settings/SettingsNavRail.tsx'))
    expect(rail).not.toContain('visibleTabsOf')
    expect(rail).not.toContain('detailedOnly')
  })

  it('★★ 设置只有一个界面：全局层里不许再挂旧弹窗', () => {
    /* 真机踩过：两处都用 settingsOpen 开关 → 工作区与弹窗同时挂载，
       导航出现两遍（nav 计数 2），两份「当前设置页」并存。 */
    const layers = strip(read('src/components/layout/GlobalLayers.tsx'))
    expect(layers).not.toContain('SettingsModal')
    const lazy = strip(read('src/components/layout/lazyAppParts.ts'))
    expect(lazy).not.toContain('SettingsModal')
  })
})

describe('设置工作区 / ⑤ 返回聊天与键盘可达', () => {
  it('★ 有明确的「返回聊天」入口', () => {
    const ws = strip(read('src/components/settings/SettingsWorkspace.tsx'))
    expect(ws).toContain('返回聊天')
    expect(ws).toContain('closeSettings')
  })

  it('★ 导航支持 ↑/↓/Home/End（不用鼠标也能走完 13 页）', () => {
    const rail = strip(read('src/components/settings/SettingsNavRail.tsx'))
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(rail, `缺 ${key}`).toContain(key)
    }
  })

  it('★ 选中态用 aria-current / aria-selected 表达（读屏能认）', () => {
    const rail = strip(read('src/components/settings/SettingsNavRail.tsx'))
    expect(rail).toContain('aria-current')
    expect(rail).toContain('aria-selected')
  })
})

describe('设置工作区 / ⑥ 窄窗口不裁切', () => {
  it('★ 内容区有最大宽度 + 居中（超宽屏不被拉成一条）', () => {
    const page = strip(read('src/components/settings/SettingsPage.tsx'))
    expect(page).toContain('max-w-3xl')
    expect(page).toContain('mx-auto')
  })

  it('★ 内容区自己滚，且允许收缩（min-w-0，窄窗口不撑破）', () => {
    /* 外壳只管横向收缩；纵向滚动在页面容器里（导航列与内容各自滚，互不牵连） */
    const ws = strip(read('src/components/settings/SettingsWorkspace.tsx'))
    expect(ws).toContain('min-w-0')
    const page = strip(read('src/components/settings/SettingsPage.tsx'))
    expect(page).toContain('overflow-y-auto')
    expect(page).toContain('shrink-0')
  })

  it('★ 导航列固定宽度且可滚（13 项在矮窗口里也能翻到底）', () => {
    const rail = strip(read('src/components/settings/SettingsNavRail.tsx'))
    expect(rail).toContain('shrink-0')
    expect(rail).toContain('overflow-y-auto')
  })
})
