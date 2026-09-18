/*
 * browse_click —— 点击当前页面的某个元素（「手」）
 *
 * index 来自 browse_elements 返回的 [N]。点击用的是和 browse_elements
 * **完全一样的遍历逻辑**（见 src/components/layout/browser/scripts.ts 的
 * __walkInteractive），所以索引两边对得上 —— 点错元素比点不中还糟。
 *
 * 点击后页面可能变化（跳转、弹窗、内容更新），模型应该再 browse_elements
 * 看新状态，而不是凭旧清单继续点。
 */

module.exports = {
  name: 'browse_click',
  description:
    '点击当前浏览器页面上的某个元素。index 来自 browse_elements 返回的索引（比如 [3] 就用 index=3）。先 browse_elements 看页面上有什么，再按索引点。点击后页面可能变化，应该再 browse_elements 看新状态。',
  parameters: {
    type: 'object',
    properties: {
      index: {
        type: 'integer',
        description: '要点的元素索引，来自 browse_elements 返回的 [N]',
      },
    },
    required: ['index'],
  },

  /** 占浏览器标签，和 browse 一样归到写操作那一类 */
  network: true,

  summarize(args) {
    return `点击页面元素 #${args?.index}`
  },

  async run(args, ctx) {
    const index = Number(args?.index)
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('index 要是 browse_elements 返回的那个数字索引（比如 3）')
    }

    const browser = require('../../handlers/browser.cjs')
    const result = await browser.request('click', { index }, ctx?.signal)
    if (!result.ok) {
      throw new Error(result.error)
    }
    return `已点击 <${result.click || '元素'}>。页面可能变了，需要的话再 browse_elements 看新状态。`
  },
}
