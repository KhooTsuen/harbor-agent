import { beforeEach, describe, expect, it } from 'vitest'
import { useBrowserStore, visibleTabOf } from '../useBrowserStore'

/* ══════════════════════════════════════════════════════════════
   Agent 的 browse 请求怎么落成标签

   ★ 真机抓到的 bug：同一个页面换个写法（`example.com` / `example.com/`）
   store 就当成两个地址 —— 开第二个标签 → webview 重建 → 页面重新加载。
   ══════════════════════════════════════════════════════════════ */

const nav = (id: string, url: string): void =>
  useBrowserStore.getState().requestBrowse({ id, action: 'navigate', url })

describe('浏览器标签：Agent 请求', () => {
  beforeEach(() => {
    useBrowserStore.getState().closeAll()
  })

  it('★ 同一个页面的不同写法复用标签，不开新的', () => {
    nav('r1', 'https://example.com')
    expect(useBrowserStore.getState().tabs).toHaveLength(1)

    nav('r2', 'https://example.com/')
    const state = useBrowserStore.getState()
    expect(state.tabs).toHaveLength(1)
    /* 复用意味着 activeId 没变、reloadKey 没动 —— webview 不会被重建 */
    expect(state.activeId).toBe(state.tabs[0]?.id)
  })

  it('不同页面才开新标签', () => {
    nav('r1', 'https://example.com')
    nav('r2', 'https://example.org')
    expect(useBrowserStore.getState().tabs).toHaveLength(2)
  })

  it('点同一个页面的不同位置（锚点）算不同标签', () => {
    nav('r1', 'https://example.com/doc#a')
    nav('r2', 'https://example.com/doc#b')
    expect(useBrowserStore.getState().tabs).toHaveLength(2)
  })

  it('snapshot / click / type 只操作当前页面，绝不开新标签', () => {
    nav('r1', 'https://example.com')
    for (const action of ['snapshot', 'click', 'type'] as const) {
      useBrowserStore.getState().requestBrowse({ id: `p-${action}`, action, url: '' })
    }
    const state = useBrowserStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.pending?.action).toBe('type')
  })
})

/* ══════════════════════════════════════════════════════════════
   每个会话只有**一个** Agent 标签（真机反馈 1b）

   以前按地址复用：同一个会话里连读五个页面 → 标签栏堆五个，
   用户看到一排「它开过的网页」，还得自己关。
   ══════════════════════════════════════════════════════════════ */

const navIn = (id: string, sessionId: string, url: string): void =>
  useBrowserStore.getState().requestBrowse({ id, action: 'navigate', url, sessionId })

describe('浏览器标签：一个地址一个标签（按会话隔离）', () => {
  beforeEach(() => {
    useBrowserStore.getState().closeAll()
  })

  it('★ 同一会话里换页面 → **新开一个标签**（用户要看它开了哪些网页）', () => {
    navIn('r1', 's1', 'https://example.com')
    navIn('r2', 's1', 'https://example.org')
    const state = useBrowserStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.tabs.map((t) => t.url).sort()).toEqual([
      'https://example.com',
      'https://example.org',
    ])
    /* 新开的那一个自动成为当前标签 */
    expect(state.activeId).toBe(state.tabs[1]?.id)
  })

  it('同一会话、同一条地址（含写法差异）：复用，不白开也不重建', () => {
    navIn('r1', 's1', 'https://example.com/a')
    const before = useBrowserStore.getState().tabs[0]?.reloadKey ?? 0
    navIn('r2', 's1', 'https://example.com/a')
    const state = useBrowserStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]?.reloadKey).toBe(before)
  })

  it('两个会话各占一个标签，互不顶掉', () => {
    navIn('r1', 's1', 'https://example.com')
    navIn('r2', 's2', 'https://example.org')
    const tabs = useBrowserStore.getState().tabs
    expect(tabs).toHaveLength(2)
    expect(tabs.map((t) => t.sessionId).sort()).toEqual(['s1', 's2'])
  })

  it('用户自己开的标签不当成 Agent 的复用对象（不许偷偷改它的地址）', () => {
    useBrowserStore.getState().open('https://user.example/page')
    navIn('r1', 's1', 'https://example.com')
    const tabs = useBrowserStore.getState().tabs
    expect(tabs).toHaveLength(2)
    expect(tabs.find((t) => t.sessionId === '')?.url).toBe('https://user.example/page')
  })

  it('已经开着同一个页面时不再白开一个（顺手认领成本会话的标签）', () => {
    useBrowserStore.getState().open('https://example.com')
    navIn('r1', 's1', 'https://example.com/')
    const tabs = useBrowserStore.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.sessionId).toBe('s1')
    /* 地址没真的变，别改写它 */
    expect(tabs[0]?.url).toBe('https://example.com')
  })

  it('重载只重建当前标签', () => {
    navIn('r1', 's1', 'https://example.com')
    navIn('r2', 's2', 'https://example.org')
    const a = useBrowserStore.getState().tabs[0]?.id ?? ''
    const b = useBrowserStore.getState().tabs[1]?.id ?? ''
    useBrowserStore.getState().select(a)
    useBrowserStore.getState().reload()
    const after = useBrowserStore.getState().tabs
    expect(after.find((t) => t.id === a)?.reloadKey).toBe(1)
    expect(after.find((t) => t.id === b)?.reloadKey).toBe(0)
  })
})

/* ══════════════════════════════════════════════════════════════
   「Agent 动过网页」的角标（收尾第一步）

   原来那条线索只有「右栏悄悄切到浏览器标签」—— 用户在看对话时等于没有。
   角标是**用户自己看没看过**的标志，所以「点开看过就减掉」是它的一半功能。
   ══════════════════════════════════════════════════════════════ */

describe('浏览器标签：Agent 活动角标', () => {
  beforeEach(() => {
    useBrowserStore.getState().closeAll()
  })

  it('没动过网页时是暗的', () => {
    expect(useBrowserStore.getState().agentAt).toBe(0)
  })

  it('动一次就亮', () => {
    useBrowserStore.getState().markAgentActivity()
    expect(useBrowserStore.getState().agentAt).toBeGreaterThan(0)
  })

  it('用户点开看过之后减掉', () => {
    useBrowserStore.getState().markAgentActivity()
    useBrowserStore.getState().clearAgentActivity()
    expect(useBrowserStore.getState().agentAt).toBe(0)
  })

  it('把浏览器标签全关掉时一并复位（下次开不该带着旧角标）', () => {
    useBrowserStore.getState().markAgentActivity()
    useBrowserStore.getState().closeAll()
    expect(useBrowserStore.getState().agentAt).toBe(0)
  })
})

/* ══════════════════════════════════════════════════════════════
   标签按会话隔离（真机反馈 6）

   以前标签是全局一栏：给会话 A 开的页面，切到会话 B 也摆在那里。
   现在每个标签记着归属，「看到的 / 被 Agent 驱动的」只有本会话那一个。
   ══════════════════════════════════════════════════════════════ */

describe('浏览器标签：按会话隔离', () => {
  beforeEach(() => {
    useBrowserStore.getState().closeAll()
  })

  it('★ visibleTabOf 只看本会话的标签', () => {
    navIn('r1', 's1', 'https://example.com')
    const tabs = useBrowserStore.getState().tabs
    expect(visibleTabOf(tabs, 's1', '')?.url).toBe('https://example.com')
    expect(visibleTabOf(tabs, 's2', '')).toBeUndefined()
  })

  it('activeId 指着别的会话时，退回本会话最后一个标签', () => {
    navIn('r1', 's1', 'https://example.com')
    navIn('r2', 's2', 'https://example.org')
    const tabs = useBrowserStore.getState().tabs
    const s2Id = tabs.find((t) => t.sessionId === 's2')?.id ?? ''
    const shown = visibleTabOf(tabs, 's1', s2Id)
    expect(shown?.sessionId).toBe('s1')
    expect(shown?.url).toBe('https://example.com')
  })

  it('用户自己开的标签带上会话号后属于本会话（owner 还是 user）', () => {
    useBrowserStore.getState().open('https://user.example', 's1')
    const tabs = useBrowserStore.getState().tabs
    expect(tabs[0]?.owner).toBe('user')
    expect(visibleTabOf(tabs, 's1', '')?.url).toBe('https://user.example')
  })

  it('closeAll 带上会话号：只关那一个会话的标签', () => {
    navIn('r1', 's1', 'https://example.com')
    navIn('r2', 's2', 'https://example.org')
    useBrowserStore.getState().closeAll('s1')
    const tabs = useBrowserStore.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.sessionId).toBe('s2')
  })

  it('closeAll 带上会话号：那个会话在跑的请求一起清掉（好让界面当面回话）', () => {
    navIn('r1', 's1', 'https://example.com')
    useBrowserStore.getState().closeAll('s1')
    expect(useBrowserStore.getState().pending).toBeNull()
  })

  it('closeAll 不传参数：全关（收尾 / 测试用）', () => {
    navIn('r1', 's1', 'https://example.com')
    navIn('r2', 's2', 'https://example.org')
    useBrowserStore.getState().closeAll()
    expect(useBrowserStore.getState().tabs).toHaveLength(0)
  })
})
