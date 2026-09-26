import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { anchorShift, readAnchor } from '@/lib/scrollAnchor'
import {
  bottomDistance,
  clickButton,
  contentChildren,
  dims,
  fixture,
  growAbove,
  growTail,
  jumpVisible,
  layout,
  rects,
  render,
  scroller,
  setup,
  streamingMsg,
  teardown,
  userScrollTo,
  viewportTopOf,
  wheel,
  writes,
} from './scrollHarness'

/* ══════════════════════════════════════════════════════════════
   FREE 的 delta 补偿 —— 验收 a / g 的机制层

   FREE 的补偿量**不是** `newScrollHeight - oldScrollHeight`，而是
   「视野顶那条内容在文档里被推下去多少」：

     · 末尾长高（流式追加）        → 位移 0 → 一个字节都不写（不拽人）
     · 视野上方长高（展开上方的块）→ 位移 = 长高量 → 补一刀（视图不跳）

   最后一条是**真机回归**：程序写的那一刀会带来一个 scroll 事件，它必须被
   认领（落点比对）而不是被当成「用户滚到底」—— 否则 FREE 会被翻回 FOLLOW
   （真机抓到过：展开 3534px 的思考块 → 模式翻回 FOLLOW、按钮消失）。
   ══════════════════════════════════════════════════════════════ */

beforeEach(setup)
afterEach(teardown)

describe('FREE 的 delta 补偿（按锚点位移量，不按高度差）', () => {
  it('a ★ 视野上方长高（展开上方的块）→ 只补位移量：视野顶那条内容一动不动', () => {
    render([fixture({ id: 'h1', content: '历史回答' }), streamingMsg])
    layout([900, 900]) // 两条消息，各 900px（内容 1800 / 视口 500）
    userScrollTo(600) // 拖到中间 = 迁移 2 → FREE
    expect(jumpVisible()).toBe(true)

    const anchor = contentChildren()[0]
    const viewBefore = viewportTopOf(anchor)
    const writesBefore = writes.count

    growAbove(0, 300) // 上面插了 300px（= 展开视野上方的块）

    expect(writes.count - writesBefore).toBe(1) // 恰好补一刀
    expect(dims.scrollTop).toBe(900) // 600 + 300
    expect(viewportTopOf(anchor)).toBe(viewBefore) // 视觉位置不动
    expect(jumpVisible()).toBe(true) // 状态没被程序动作改掉
  })

  it('d/f ★ 末尾长高（流式追加）→ 位移 0：一个字节都不写，也不拽人', () => {
    render([fixture({ id: 'h1', content: '历史回答' }), streamingMsg])
    layout([900, 900])
    userScrollTo(600)

    const anchor = contentChildren()[0]
    const viewBefore = viewportTopOf(anchor)
    const writesBefore = writes.count

    growTail(400)
    growTail(400)

    expect(writes.count).toBe(writesBefore) // 零写入
    expect(dims.scrollTop).toBe(600)
    expect(viewportTopOf(anchor)).toBe(viewBefore)
    expect(jumpVisible()).toBe(true)
  })

  it('g ★ 反复展开/折叠（上方 +250 / −250，三遍）→ 每次都精确回位，不抖', () => {
    render([fixture({ id: 'h1', content: '历史回答' }), streamingMsg])
    layout([900, 900])
    userScrollTo(600)

    const anchor = contentChildren()[0]
    const viewBefore = viewportTopOf(anchor)

    for (let round = 0; round < 3; round += 1) {
      growAbove(0, 250)
      expect(dims.scrollTop).toBe(850)
      expect(viewportTopOf(anchor)).toBe(viewBefore)
      expect(jumpVisible()).toBe(true)

      growAbove(0, -250)
      expect(dims.scrollTop).toBe(600)
      expect(viewportTopOf(anchor)).toBe(viewBefore)
      expect(jumpVisible()).toBe(true)
    }
  })

  it('★ 程序补偿落在「真正的底」时，它自己那个 scroll 事件不许把 FREE 翻回 FOLLOW', () => {
    render([fixture({ id: 'h1', content: '历史回答' }), streamingMsg])
    layout([700, 100]) // 内容 800 / 视口 500 → 贴底 = 300
    expect(bottomDistance()).toBe(0) // 打开即 FOLLOW 贴底

    clickButton('正在思考') // 迁移 4：点开最新思考块（此刻人还在底部）
    expect(jumpVisible()).toBe(true)

    growAbove(0, 400) // 展开的 400px 在视野上方 → 补偿 400，离底仍是 0
    expect(dims.scrollTop).toBe(700) // 300 + 400（= 新的贴底位置）

    /* 浏览器会为「程序改了 scrollTop」发一个 scroll 事件 —— 落点比对必须认领它 */
    act(() => {
      scroller().dispatchEvent(new Event('scroll'))
    })
    expect(jumpVisible()).toBe(true) // ★ 仍是 FREE（旧实现这里会被翻回 FOLLOW）
  })

  it('FOLLOW 下只认「贴底」这一条（锚点逻辑不插手贴底）', () => {
    render([fixture({ id: 'h1', content: '历史回答' }), streamingMsg])
    layout([900, 900])
    expect(bottomDistance()).toBe(0)

    wheel(120) // 已经在底 → 仍是 FOLLOW（迁移 3）
    expect(jumpVisible()).toBe(false)

    growTail(300)
    expect(dims.scrollTop).toBe(dims.contentHeight - dims.clientHeight)
    expect(jumpVisible()).toBe(false)
  })

  it('h ★ 切回对话时内容还没渲染完 → 位置先挂着，装得下再落（不能 clamp 成 0）', () => {
    render([fixture({ id: 'h1', content: '历史回答' }), streamingMsg], 'A')
    layout([700, 100]) // A：内容 800
    userScrollTo(200) // A 里用户自己选了「看历史」
    expect(jumpVisible()).toBe(true)

    render([fixture({ id: 'b1', content: 'B 的回答' })], 'B') // 切到 B（首次 → FOLLOW）
    layout([300]) // B 的列表很短（内容 300 < 视口 500）
    expect(jumpVisible()).toBe(false)

    render([fixture({ id: 'h1', content: '历史回答' }), streamingMsg], 'A') // 切回 A：此刻渲染的还是 B 的尺寸
    expect(dims.scrollTop).toBe(0) // 装不下 → 先挂着（不是把位置丢了，也没写成 0）
    expect(jumpVisible()).toBe(true) // 但意图已经是 FREE

    layout([700, 100]) // A 的列表铺出来（尺寸变化 = ResizeObserver 触发点）
    expect(dims.scrollTop).toBe(200) // ★ 位置落回来了
    expect(jumpVisible()).toBe(true)
  })

  it('h2 ★ 目标位置装不下时：等内容长定再落（落到能到的最大值，不是丢掉）', () => {
    render([fixture({ id: 'h1', content: '历史回答' }), streamingMsg], 'A')
    layout([900, 900]) // A：内容 1800
    userScrollTo(600) // A 里看历史
    expect(jumpVisible()).toBe(true)

    render([fixture({ id: 'b1', content: 'B 的回答' })], 'B')
    layout([300])
    render([fixture({ id: 'h1', content: '历史回答' }), streamingMsg], 'A')
    layout([400, 200]) // 切回来只铺了一半（内容 600，能到的最大是 100）
    expect(dims.scrollTop).toBe(100) // 先落到能到的最大值（不是丢掉，也不是卡在 0）

    growTail(1400) // 列表补齐（内容 2000 → 装得下 600 了）
    expect(dims.scrollTop).toBe(600) // ★ 准确位置落回来
    expect(jumpVisible()).toBe(true)
  })

  it('★ 内容变矮时浏览器把 scrollTop 钳到底 → 那是程序行为，不许把 FREE 翻成 FOLLOW', () => {
    render([fixture({ id: 'h1', content: '历史回答' }), streamingMsg])
    layout([900, 900]) // 内容 1800 / 视口 500 → 贴底 = 1300
    expect(bottomDistance()).toBe(0) // 打开即 FOLLOW

    clickButton('正在思考') // 迁移 4：点开块 → FREE
    expect(jumpVisible()).toBe(true)

    growTail(-600) // 内容变矮（折叠 / 重排）→ 旧位置 1300 已经在新的最大滚动量（700）之外
    dims.scrollTop = dims.contentHeight - dims.clientHeight // 浏览器把它钳到底
    act(() => {
      scroller().dispatchEvent(new Event('scroll'))
    })
    /* 钳出来的那一下离底是 0（4px 以内），但它是程序行为：状态必须原样不动。
       旧实现这里会翻成 FOLLOW，然后一路贴底跟流 —— 就是「对话进行时被强制下滑」。 */
    expect(jumpVisible()).toBe(true) // ★ 仍是 FREE
    expect(dims.scrollTop).toBe(700)
  })

  it('h3 ★ 切走那一刻列表已经卸载（空对话先渲染开屏）→ 位置也记得住，不许记成 0', () => {
    render([fixture({ id: 'h1', content: '历史回答' }), streamingMsg], 'A')
    layout([700, 100]) // A：内容 800
    userScrollTo(200) // A 里用户自己选了「看历史」
    expect(jumpVisible()).toBe(true)

    /* 真机踩过：切到一个空对话 → 先渲染开屏 → 滚动容器**这一刻就被卸载**，
       于是 ref 为 null；记位置若去读 DOM，存下来的就是 0，切回来位置就丢了。 */
    render([], 'B')
    render([fixture({ id: 'h1', content: '历史回答' }), streamingMsg], 'A')
    layout([700, 100])
    expect(jumpVisible()).toBe(true)
    expect(dims.scrollTop).toBe(200) // ★ 旧实现这里会变成 0
  })

  /*
   * 锚点备胎阶梯（lib/scrollAnchor）—— 嵌套结构这里的假尺子量不出来，
   * 所以自己搭一棵真 DOM 树：
   *   content > block(900) > [inner(400), innerNext(500)], para(200)
   * 视野顶端落在 inner 上；折叠 block 时 inner 与 innerNext 一起被删。
   */
  const buildTree = () => {
    const sc = document.createElement('div')
    sc.tabIndex = -1
    const content = document.createElement('div')
    content.className = 'max-w-3xl'
    const block = document.createElement('div')
    const inner = document.createElement('p')
    const innerNext = document.createElement('p')
    const para = document.createElement('p')
    block.append(inner, innerNext)
    content.append(block, para)
    sc.append(content)
    document.body.append(sc)
    rects.set(block, { offset: 0, height: 900 })
    rects.set(inner, { offset: 0, height: 400 })
    rects.set(innerNext, { offset: 400, height: 500 })
    rects.set(para, { offset: 900, height: 200 })
    dims.scrollTop = 300
    return { sc, content, block, inner, innerNext, para }
  }

  it('★ 锚点连同近处兄弟一起被删（折叠跨视野顶端的块）→ 退到后面的兄弟，照样得出 -900', () => {
    const { sc, content, block, inner, innerNext, para } = buildTree()
    const anchor = readAnchor(sc, content)
    expect(anchor?.primary.node).toBe(inner)
    expect(anchor?.backstops.map((b) => b.node)).toEqual([innerNext, para, content])

    block.remove() // 折叠：整棵子树被删
    rects.set(para, { offset: 0, height: 200 }) // 后面那段内容往上顶 900px
    /* 旧实现：primary 死了、备胎只留了一个（innerNext）也死了 → 返回 null 永不补偿 */
    expect(anchorShift(sc, anchor)).toBe(-900)
    sc.remove()
  })

  it('★ 锚点与备胎全没了 → 退到内容容器（位移 0），不瞎猜', () => {
    const { sc, content, block, para } = buildTree()
    const anchor = readAnchor(sc, content)
    block.remove()
    para.remove()
    expect(anchorShift(sc, anchor)).toBe(0)
    sc.remove()
  })
})
