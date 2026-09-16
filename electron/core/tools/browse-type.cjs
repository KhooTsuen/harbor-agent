/*
 * browse_type —— 往当前页面的输入框里打字（「手」的第二个动作）
 *
 * index 来自 browse_elements 返回的 [N]，必须是输入框/文本域（不是就报错，
 * 而不是静默什么都不做 —— 那样模型会以为打进去了，继续往下走）。
 *
 * ⚠️ 这个动作对「受控组件」有坑：直接设 `el.value` 会被 React/Vue 忽略，
 * 真正的赋值逻辑在 src/components/layout/browser/scripts.ts 的 typeScript 里
 * （用原型上的 native setter + dispatch input 事件）。
 *
 * 打完字页面可能变化（自动补全、表单校验、提交），模型应该再 browse_elements
 * 看新状态，而不是凭旧清单继续操作。
 */

module.exports = {
  name: 'browse_type',
  description:
    '往当前浏览器页面的输入框里打字。index 来自 browse_elements 返回的索引（那个元素必须是输入框/文本域）。可选 pressEnter 在输入后回车（搜索、登录常用）。输入后页面可能变化，应该再 browse_elements 看新状态。',
  parameters: {
    type: 'object',
    properties: {
      index: {
        type: 'integer',
        description: '输入框的索引，来自 browse_elements 返回的 [N]',
      },
      text: {
        type: 'string',
        description: '要输入的文字',
      },
      pressEnter: {
        type: 'boolean',
        description: '输入后要不要按回车（搜索/登录常用），默认否',
      },
    },
    required: ['index', 'text'],
  },

  /** 占浏览器标签，和 browse 一样归到写操作那一类 */
  network: true,

  summarize(args) {
    const text = String(args?.text ?? '').slice(0, 20)
    return `往页面元素 #${args?.index} 输入「${text}」`
  },

  async run(args) {
    const index = Number(args?.index)
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('index 要是 browse_elements 返回的那个数字索引（比如 3）')
    }
    const text = String(args?.text ?? '')
    if (!text) throw new Error('要给我要输入的文字')

    const browser = require('../../handlers/browser.cjs')
    const result = await browser.request('type', {
      index,
      text,
      pressEnter: Boolean(args?.pressEnter),
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
    const enter = args?.pressEnter ? '，并回车' : ''
    return `已在 <${result.into || '输入框'}> 输入「${result.type || ''}」${enter}。页面可能变了，需要的话再 browse_elements 看新状态。`
  },
}
