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

  it('★ B5：nav 不再经过 store（后退/前进改由主进程经 CDP 直连）', () => {
    /* 只有 navigate 会进 store；nav 由 selectAgentTab 在界面上选中 Agent 标签就够 */
    useBrowserStore.setState({
      tabs: [
        {
          id: 't1',
          url: 'https://example.com/list',
          sessionId: 'sess-1',
          owner: 'agent',
          reloadKey: 0,
        },
      ],
      activeId: 't1',
      pending: null,
      queue: [],
    })
    const before = tabsOfSession(useBrowserStore.getState().tabs, 'sess-1').length

    /* 用户切走 → nav 时把它拨回 Agent 的标签 */
    useBrowserStore.getState().open('https://user.example/page', 'sess-1')
    useBrowserStore.getState().selectAgentTab('sess-1')

    expect(useBrowserStore.getState().activeId).toBe('t1')
    /* 不开新标签：用户那个标签照在，Agent 标签也照在 */
    expect(tabsOfSession(useBrowserStore.getState().tabs, 'sess-1').length).toBe(before + 1)
    /* 也不进 pending（没人等回话） */
    expect(useBrowserStore.getState().pending).toBeNull()
  })

  it('navigate 才走队列（B5 后唯有它会入队）', () => {
    useBrowserStore.getState().requestBrowse({
      id: 'r1',
      action: 'navigate',
      url: 'https://example.com/a',
      sessionId: 'sess-1',
    })
    useBrowserStore.getState().requestBrowse({
      id: 'r2',
      action: 'navigate',
      url: 'https://example.com/b',
      sessionId: 'sess-1',
    })

    expect(useBrowserStore.getState().pending?.id).toBe('r1')
    expect(useBrowserStore.getState().queue.map((item) => item.id)).toEqual(['r2'])
  })
})
