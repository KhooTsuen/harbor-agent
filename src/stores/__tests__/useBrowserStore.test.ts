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
