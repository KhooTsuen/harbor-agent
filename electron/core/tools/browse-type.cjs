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
 * ── 密码框：光靠提示词约束不够 ──
 * 「帮用户填密码」是用户自己都该盯一眼的动作，所以这里**卡一道**：
 * 密码框必须先拿到用户明确授权（确认弹窗点过「允许」）才真的填。
 * 和危险 shell 命令一个道理 —— 即使权限配了「完全访问」也要问一次。
 * （webview 那边的脚本也有一道：没带授权就直接不填。）
 */

const redact = require('../redact.cjs')

module.exports = {
  name: 'browse_type',
  description:
    '往当前浏览器页面的输入框里打字。index 来自 browse_elements 返回的索引（那个元素必须是输入框/文本域）。可选 pressEnter 在输入后回车（搜索、登录常用）。密码框会弹确认框让用户授权（用户明确说了可以填密码时才该调用；内容不会显示、也不进对话记录）。输入后页面可能变化，应该再 browse_elements 看新状态。',
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

  /** 摘要里**不带具体内容** —— 可能是密码，摘要会进确认弹窗、日志和审计 */
  summarize(args) {
    const len = String(args?.text ?? '').length
    return `往页面元素 #${args?.index} 输入 ${len} 个字符`
  },

  async run(args, ctx = {}) {
    const index = Number(args?.index)
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('index 要是 browse_elements 返回的那个数字索引（比如 3）')
    }
    const text = String(args?.text ?? '')
    if (!text) throw new Error('要给我要输入的文字')
    const pressEnter = Boolean(args?.pressEnter)

    const browser = require('../../handlers/browser.cjs')
    let result = await browser.request('type', { index, text, pressEnter }, ctx?.signal)

    /*
     * 一旦确认这是密码框，**立刻**把这个值登记成「已知密钥」：
     * 之后它出现在审计 / 日志 / 会话落盘里都会被换成 `***已隐藏***`。
     * 必须在这里做 —— 审计是在 run() 返回**之后**才写的，那时登记已经来不及。
     */
    if (result.needsConfirm === true || result.password === true) {
      redact.remember(text)
    }

    /* 密码框：先不动，等用户明确授权 */
    if (!result.ok && result.needsConfirm) {
      if (typeof ctx.confirm !== 'function') {
        throw new Error('这是密码框，要你确认过才能填 —— 当前没有确认界面，按拒绝处理')
      }
      const approved = await ctx.confirm({
        kind: 'risk',
        name: 'browse_type',
        args,
        summary: `要在「密码框」里输入 ${text.length} 个字符。\n内容不会显示在对话里，也不会写进记录。确认是你授权的吗？`,
      })
      if (!approved) return '你拒绝了往密码框里输入，那就没填。'
      result = await browser.request(
        'type',
        { index, text, pressEnter, authorized: true },
        ctx?.signal,
      )
    }

    if (!result.ok) throw new Error(result.error)

    const enter = pressEnter ? '，并回车' : ''
    return `已在 <${result.into || '输入框'}> 输入「${result.type || ''}」${enter}。页面可能变了，需要的话再 browse_elements 看新状态。`
  },
}
