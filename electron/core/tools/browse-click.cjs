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
      force: {
        type: 'boolean',
        description:
          '落点被别的元素挡住时是否强制点击。默认否（拒绝并告诉你被谁挡住了）。只有确认遮挡可忽略时才带 true。落点在视口外时 force 也不放行。',
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
    /* sessionId 跟着下去：主进程要用它做「浏览通知」的去重与点击跳转 */
    const result = await browser.request(
      'click',
      { index, force: args?.force === true, sessionId: ctx?.sessionId },
      ctx?.signal,
    )
    if (!result.ok) {
      throw new Error(result.error)
    }
    /*
     * 真点击由**主进程**派发（sendInputEvent → isTrusted: true）。
     * 渲染层只算好了落点 + webContentsId —— 见 core/real-input.cjs 的文件头。
     */
    const realInput = require('../real-input.cjs')
    const fired = realInput.clickAt(result.webContentsId, result.x, result.y)
    if (!fired.ok) throw new Error(fired.error)

    const forced = result.obstructed
      ? '（注意：这个元素当时被遮住了，是按 force 强点的，事件未必真落到它身上）'
      : ''
    return `已点击 <${result.click || '元素'}>${forced}。页面可能变了，需要的话再 browse_elements 看新状态。`
  },
}
