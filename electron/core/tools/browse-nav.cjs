/*
 * browse_nav —— 在当前浏览器标签里「后退一页 / 前进一页」（用浏览器自己的历史）
 *
 * 为什么要有它（用户 2026-10-06 拍板）：
 *   到这一版为止，Agent 只会 `browse`（打开并读一个地址）。于是「点进详情看完了，
 *   回到列表」这种最普通的动作，它只能**再 browse 一次列表地址** ——
 *   多出来的那个标签是新的（滚动位置、筛选条件全丢），而且用户看到的是
 *   「它又开了一遍刚才那个页面」，完全看不出它是在回退。
 *
 *   `browse_nav` 让它在**同一个标签**里用历史回退 —— 标签不增、状态不丢。
 *   这也是「别滥用标签」的另一半：能后退解决的，不要开新标签。
 *
 * ⚠️ 它不导航到**任意**地址（那还是 `browse` 的活）：只有 back / forward 两个值。
 *    「让模型自己拼一个地址去导」是不做的 —— 地址该由页面决定，不该由模型编。
 */

const { wrapWebText } = require('./_web-note.cjs')

module.exports = {
  name: 'browse_nav',
  description:
    '在当前浏览器标签里后退或前进一页（用浏览器的历史记录，不会新开标签）。用它回到刚才那个页面 —— 比如点进详情看完了要回列表、翻到下一页后想回上一页。只能 back / forward，不能去任意地址（那用 browse）。',
  parameters: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        enum: ['back', 'forward'],
        description: 'back = 上一页，forward = 下一页',
      },
    },
    required: ['direction'],
  },

  /** 会联网，而且占用用户正在看的浏览器标签 —— 和 browse 一样归到写操作那一类 */
  network: true,

  summarize(args) {
    return args?.direction === 'forward' ? '网页前进一页' : '网页后退一页'
  },

  async run(args, ctx) {
    const direction = String(args?.direction ?? '')
      .trim()
      .toLowerCase()
    if (direction !== 'back' && direction !== 'forward') {
      throw new Error('direction 只能是 "back"（上一页）或 "forward"（下一页）')
    }

    const browser = require('../../handlers/browser.cjs')
    /* sessionId 与 signal 跟 browse 一样传：通知去重、点停止时不干等那 45 秒 */
    const result = await browser.request('nav', { direction, sessionId: ctx?.sessionId }, ctx?.signal)
    if (!result.ok) {
      throw new Error(
        `${result.error}。要打开新页面用 browse；想看当前页面上有什么用 browse_elements。`,
      )
    }

    const label = direction === 'back' ? '已后退到上一页。' : '已前进到下一页。'
    const body = wrapWebText({
      url: result.url || '',
      title: result.title ?? '',
      text: result.text ?? '',
      truncated: result.truncated === true,
    })
    return `${label}\n${body}`
  },
}
