import { beforeEach, describe, expect, it } from 'vitest'
import { agentTabOf, useBrowserStore } from '../useBrowserStore'

/* ══════════════════════════════════════════════════════════════
   Agent 自己决定「开新标签」还是「在当前标签里打开」

   背景（2026-10-07 真机反馈「AI 一口气开太多标签」）：工具只有 browse
   （必然开新标签）和 browse_nav（只能挪历史），模型没有表达「这个页面只是中转」
   的办法，只能一个地址一个标签地堆。新增 `sameTab` 把决定权交回给它；
   同时把 `owner` 这个**死字段**真正读起来 —— Agent 的操作不该落在用户开的标签上。
   ══════════════════════════════════════════════════════════════ */

const nav = (id: string, sessionId: string, url: string, sameTab = false): void =>
  useBrowserStore.getState().requestBrowse({ id, action: 'navigate', url, sessionId, sameTab })

describe('浏览器标签：sameTab（中转页不开新标签）', () => {
  beforeEach(() => useBrowserStore.getState().closeAll())

  it('★ 在当前 Agent 标签里换地址：标签数不变、地址跟着换', () => {
    nav('r1', 's1', 'https://example.com')
    nav('r2', 's1', 'https://example.com/detail', true)
    const state = useBrowserStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]?.url).toBe('https://example.com/detail')
  })

  it('★ 不重建 webview（reloadKey 不动）—— 历史留着，browse_nav 才退得回去', () => {
    nav('r1', 's1', 'https://example.com')
    const before = useBrowserStore.getState().tabs[0]?.reloadKey ?? 0
    nav('r2', 's1', 'https://example.com/detail', true)
    expect(useBrowserStore.getState().tabs[0]?.reloadKey).toBe(before)
  })

  it('★ 不碰用户自己开的标签（照常开一个 Agent 标签）', () => {
    useBrowserStore.getState().open('https://user.example/page', 's1')
    nav('r1', 's1', 'https://example.com', true)
    const tabs = useBrowserStore.getState().tabs
    expect(tabs).toHaveLength(2)
    expect(tabs.find((t) => t.owner === 'user')?.url).toBe('https://user.example/page')
    expect(tabs.find((t) => t.owner === 'agent')?.url).toBe('https://example.com')
  })

  it('本会话还没有 Agent 标签时照常开一个（不拿用户的顶替）', () => {
    nav('r1', 's1', 'https://example.com', true)
    const tabs = useBrowserStore.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.owner).toBe('agent')
  })

  it('只认本会话的 Agent 标签（别的会话的不动）', () => {
    nav('r1', 's1', 'https://example.com')
    nav('r2', 's2', 'https://other.example', true)
    const tabs = useBrowserStore.getState().tabs
    expect(tabs).toHaveLength(2)
    expect(tabs.find((t) => t.sessionId === 's1')?.url).toBe('https://example.com')
  })
})

describe('浏览器标签：Agent 的操作不落在用户自己开的标签上', () => {
  beforeEach(() => useBrowserStore.getState().closeAll())

  it('★ 用户切回自己那个标签看时，Agent 要操作就把它拨回 Agent 的标签', () => {
    nav('r1', 's1', 'https://example.com')
    const agentId = useBrowserStore.getState().tabs[0]?.id
    /* 用户自己开一个 → activeId 指向它 */
    useBrowserStore.getState().open('https://user.example', 's1')
    /* B5：操作类动作不走 store，靠 selectAgentTab 把当前标签拨回 Agent 那个 */
    useBrowserStore.getState().selectAgentTab('s1')
    expect(useBrowserStore.getState().activeId).toBe(agentId)
  })

  it('本会话没有 Agent 标签时保持原样（用户让我操作他正看的页面）', () => {
    useBrowserStore.getState().open('https://user.example', 's1')
    const userId = useBrowserStore.getState().tabs[0]?.id
    useBrowserStore.getState().selectAgentTab('s1')
    expect(useBrowserStore.getState().activeId).toBe(userId)
  })

  it('★ agentTabOf 只认 Agent 自己开的（owner 不再是个死字段）', () => {
    useBrowserStore.getState().open('https://user.example', 's1')
    nav('r1', 's1', 'https://example.com')
    const { tabs, activeId } = useBrowserStore.getState()
    expect(agentTabOf(tabs, 's1', activeId)?.url).toBe('https://example.com')
  })
})
