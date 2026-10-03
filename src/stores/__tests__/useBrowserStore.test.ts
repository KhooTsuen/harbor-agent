import { beforeEach, describe, expect, it } from 'vitest'
import { useBrowserStore } from '../useBrowserStore'

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
