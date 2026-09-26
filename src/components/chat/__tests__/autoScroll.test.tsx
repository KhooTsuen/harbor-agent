import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bottomDistance,
  clickButton,
  dims,
  fixture,
  grow,
  historyMsg,
  jumpVisible,
  render,
  setup,
  streamingMsg,
  teardown,
  userScrollTo,
  wheel,
  writes,
} from './scrollHarness'

/* ══════════════════════════════════════════════════════════════
   滚动状态机 —— 验收 a–h

   契约（`hooks/useAutoScroll.ts`，五条迁移、严格 FREE 优先）：
     FOLLOW 看最新 / FREE 看历史；程序行为不改状态；FREE 时程序零写入。
   这里每一条都用「假尺子 + 写次数」钉住。
   ══════════════════════════════════════════════════════════════ */

beforeEach(setup)
afterEach(teardown)

describe('滚动状态机（验收 a–h）', () => {
  it('a 长对话滚到中间，点开历史思考块 → 视图不跳、不移动（FREE，程序零写入）', () => {
    render([historyMsg, streamingMsg])
    userScrollTo(800) // 拖到中间 = 迁移 2：没到真正的底 → FREE
    expect(jumpVisible()).toBe(true)

    const before = writes.count
    clickButton('思考过程') // 迁移 4：点开历史思考块
    const top = dims.scrollTop
    grow(120) // 展开出来的思考在长高
    expect(dims.scrollTop).toBe(top)
    expect(writes.count).toBe(before) // 严格的 FREE：一个字节都没写
  })

  it('b 滚到底部，点开最新思考块 → 停在展开处，不被流式增长拽走', () => {
    render([historyMsg, streamingMsg])
    expect(bottomDistance()).toBe(0) // 打开即 FOLLOW 贴底
    expect(jumpVisible()).toBe(false)

    clickButton('正在思考') // 最新那条的思考块
    expect(jumpVisible()).toBe(true)
    const top = dims.scrollTop
    grow(60)
    grow(60)
    expect(dims.scrollTop).toBe(top)
    expect(dims.scrollTop).not.toBe(dims.contentHeight - dims.clientHeight)
  })

  it('c 流式中不点开任何块 → FOLLOW 照旧自动贴底', () => {
    render([historyMsg, streamingMsg])
    const before = writes.count
    grow(80)
    grow(80)
    expect(dims.scrollTop).toBe(dims.contentHeight - dims.clientHeight)
    expect(writes.count - before).toBe(2) // 两次增高 = 两次贴底写，没有多余动作
    expect(jumpVisible()).toBe(false) // 状态没被程序行为改掉
  })

  it('d 流式中向上滚一次 → 立即 FREE，内容再长也不拽人', () => {
    render([historyMsg, streamingMsg])
    wheel(-120) // 迁移 1：滚轮 deltaY < 0
    expect(jumpVisible()).toBe(true)
    const top = dims.scrollTop
    grow(200) // 流式还在长
    expect(dims.scrollTop).toBe(top)
  })

  it('e 向上滚过之后，自己滚到真正的底（≤4px）→ 恢复 FOLLOW', () => {
    render([historyMsg, streamingMsg])
    wheel(-120)
    grow(100)
    userScrollTo(dims.contentHeight - dims.clientHeight - 3) // 离底 3px
    expect(jumpVisible()).toBe(false) // 迁移 3
    grow(60)
    expect(dims.scrollTop).toBe(dims.contentHeight - dims.clientHeight) // 又贴上了
  })

  it('f 向下滚但停在中间 → 仍是 FREE，不自动贴底', () => {
    render([historyMsg, streamingMsg])
    userScrollTo(800)
    wheel(120) // 迁移 2：向下但没到真正的底
    expect(jumpVisible()).toBe(true)
    const top = dims.scrollTop
    grow(150)
    expect(dims.scrollTop).toBe(top)
  })

  it('g 反复展开/折叠 → 视觉位置稳定，不抖', () => {
    render([historyMsg, streamingMsg])
    userScrollTo(800)
    const before = writes.count
    for (let i = 0; i < 3; i += 1) {
      clickButton('思考过程') // 展开
      grow(90)
      clickButton('思考过程') // 折叠
      grow(-90)
    }
    expect(dims.scrollTop).toBe(800)
    expect(writes.count).toBe(before) // 三次来回，程序一次都没碰视图
  })

  it('h 切换对话：切走存意图，切回原位还原（状态 + 位置）', () => {
    render([historyMsg, streamingMsg], 'A')
    userScrollTo(800) // A：用户显式选了「看历史」
    expect(jumpVisible()).toBe(true)

    render([fixture({ id: 'b1', content: 'B 的回答' })], 'B') // B 第一次打开
    expect(jumpVisible()).toBe(false) // 默认 FOLLOW
    expect(dims.scrollTop).toBe(dims.contentHeight - dims.clientHeight)

    render([historyMsg, streamingMsg], 'A') // 切回 A
    expect(jumpVisible()).toBe(true) // 状态还原
    expect(dims.scrollTop).toBe(800) // 位置也还原
    grow(50)
    expect(dims.scrollTop).toBe(800) // 还原后仍是 FREE：不乱动
  })
})
