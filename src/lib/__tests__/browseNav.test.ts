import { beforeEach, describe, expect, it } from 'vitest'
import { browseNotice, isBrowseAction } from '@/lib/browseNotice'
import { tabsOfSession, useBrowserStore } from '@/stores/useBrowserStore'

/* ══════════════════════════════════════════════════════════════
   browse_nav（后退 / 前进）在渲染层的口径

   这个动作和 snapshot / click / type 一样属于「操作**当前**页面」——
   区别只在它真的会换页面，但换的是这个标签**自己的历史**。
   所以它必须是「不开新标签的那一类」，否则「退回去」会变成
   「又开了一遍刚才那页」（多一个标签、丢筛选和滚动位置）。

   真机反馈：AI 要能后退，而用户不希望它靠重开地址来后退。
   ══════════════════════════════════════════════════════════════ */

function reset(): void {
  useBrowserStore.setState({
    tabs: [],
    activeId: '',
    pending: null,
    queue: [],
    agentAt: 0,
  })
}

describe('browse_nav 在渲染层的口径', () => {
  beforeEach(reset)

  it('★ nav 算「在动网页」（右栏「浏览器」标签的角标要点亮）', () => {
    expect(isBrowseAction('nav')).toBe(true)
  })

  it('★ nav 会提示一句，同一种动作连着来只提示一次', () => {
    const first = browseNotice('', 'nav')
    expect(first.notice?.title).toContain('前进/后退')

    const again = browseNotice(first.key, 'nav')
    expect(again.notice).toBeNull()
  })

  it('★ nav 在当前标签里执行：**不开新标签**（这是它存在的意义）', () => {
    useBrowserStore.getState().open('https://example.com/list', 'sess-1')
    const before = tabsOfSession(useBrowserStore.getState().tabs, 'sess-1').length

    useBrowserStore
      .getState()
      .requestBrowse({ id: 'r1', action: 'nav', url: '', direction: 'back', sessionId: 'sess-1' })

    expect(tabsOfSession(useBrowserStore.getState().tabs, 'sess-1').length).toBe(before)

    /* 方向要一路带到 driver（它靠这个决定 goBack 还是 goForward） */
    expect(useBrowserStore.getState().pending?.action).toBe('nav')
    expect(useBrowserStore.getState().pending?.direction).toBe('back')
  })

  it('一个页面都没开时也不开标签（桥那边会当面回一句「先 browse 打开」）', () => {
    useBrowserStore
      .getState()
      .requestBrowse({ id: 'r2', action: 'nav', url: '', sessionId: 'sess-1' })

    expect(tabsOfSession(useBrowserStore.getState().tabs, 'sess-1')).toHaveLength(0)
    expect(useBrowserStore.getState().pending?.action).toBe('nav')
  })

  it('nav 走队列，不顶掉正在跑的那一条（并发顺序跟请求一致）', () => {
    useBrowserStore.getState().open('https://example.com/a', 'sess-1')
    useBrowserStore
      .getState()
      .requestBrowse({ id: 'r1', action: 'nav', url: '', direction: 'back', sessionId: 'sess-1' })
    useBrowserStore
      .getState()
      .requestBrowse({ id: 'r2', action: 'nav', url: '', sessionId: 'sess-1' })

    expect(useBrowserStore.getState().pending?.id).toBe('r1')
    expect(useBrowserStore.getState().queue.map((item) => item.id)).toEqual(['r2'])
  })
})
