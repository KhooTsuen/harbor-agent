import { describe, expect, it } from 'vitest'
import { browseNotice, isBrowseAction } from '../browseNotice'

/* ══════════════════════════════════════════════════════════════
   「Agent 在动网页」的那句提示（收尾第一步 / 小尾巴 #8）

   记这条测试的理由：**这个功能的坑不在实现，在"说了几遍"** ——
   一个任务里 Agent 常常 snapshot → click → type → snapshot… 连做十几步，
   每步一条 toast 会在几秒内糊满屏幕，用户只能把提示整个关掉。
   所以「同动作只提示一次、换动作才再说一句」是**功能本身**，不是优化。
   ══════════════════════════════════════════════════════════════ */

describe('browseNotice：说什么', () => {
  it('四个动作各有一句人话，不是把 action 名字直接甩给用户', () => {
    for (const action of ['navigate', 'snapshot', 'click', 'type'] as const) {
      const { notice } = browseNotice('', action, 'https://example.com')
      expect(notice?.title).toBeTruthy()
      expect(notice?.title).not.toContain(action)
    }
  })

  it('navigate 把地址带上 —— 用户要一眼看出在读哪个页面', () => {
    const { notice } = browseNotice('', 'navigate', 'https://example.com/a')
    expect(notice?.detail).toBe('https://example.com/a')
  })

  it('不认识的动作用「不提示」兜底，而不是弹一条空标题', () => {
    const { notice } = browseNotice('', 'launch-missile' as never, '')
    expect(notice).toBeNull()
  })
})

describe('browseNotice：说几遍', () => {
  it('★ 连着点 10 次只提示第 1 次', () => {
    let key = ''
    let spoken = 0
    for (let i = 0; i < 10; i += 1) {
      const result = browseNotice(key, 'click', '')
      key = result.key
      if (result.notice) spoken += 1
    }
    expect(spoken).toBe(1)
  })

  it('★ 动作换了一种才再提示一次', () => {
    const first = browseNotice('', 'snapshot', '')
    const second = browseNotice(first.key, 'click', '')
    expect(second.notice).not.toBeNull()
    /* 再回到读元素：中间隔了别的动作，用户看到的"阶段"确实变了，可以说 */
    const third = browseNotice(second.key, 'snapshot', '')
    expect(third.notice).not.toBeNull()
  })

  it('同一个页面重复读只提示一次（Agent 自己也常这么干）', () => {
    const first = browseNotice('', 'navigate', 'https://example.com')
    const again = browseNotice(first.key, 'navigate', 'https://example.com')
    expect(again.notice).toBeNull()
  })

  it('★ 换了页面就是新进展，要提示 —— 不能因为"都是 navigate"就闭嘴', () => {
    const first = browseNotice('', 'navigate', 'https://example.com')
    const other = browseNotice(first.key, 'navigate', 'https://example.org')
    expect(other.notice).not.toBeNull()
  })

  it('地址写法不同（多一个尾斜杠）不算新页面 —— 和标签复用一个判据', () => {
    const first = browseNotice('', 'navigate', 'https://example.com')
    /*
     * ⚠️ 这里**故意记录**当前行为：`browseNotice` 只做字符串比较，
     *    不做 `sameUrl`。所以尾斜杠会被当成另一个地址、多提示一次。
     *    危害有限（只是多一句话，不像标签那样会重建 webview），
     *    但真机上如果实测到重复提示，改成 sameUrl 即可 —— 记在这里免得再查一遍。
     */
    const trailing = browseNotice(first.key, 'navigate', 'https://example.com/')
    expect(trailing.notice).not.toBeNull()
  })
})

describe('isBrowseAction', () => {
  it('四个浏览动作都算', () => {
    for (const action of ['navigate', 'snapshot', 'click', 'type']) {
      expect(isBrowseAction(action)).toBe(true)
    }
  })

  it('别的工具名不算（别把角标点成万能的）', () => {
    expect(isBrowseAction('shell')).toBe(false)
    expect(isBrowseAction('')).toBe(false)
  })
})
