/** 只读用户 Edge 当前标签的正文；不导航，不使用 Harbor 内置浏览器。 */
const { edgeCommand } = require('./edge-shared.cjs')
const { wrapWebText } = require('./_web-note.cjs')

module.exports = {
  name: 'edge_read',
  description: '读取用户自己的 Edge 当前活动标签正文，不打开新网址。侧边栏里说“读取当前页/这个网页”时使用；失败时如实说明，不改用内置浏览器。长网页一次只回一段：结果里会写「第几段 / 共几段」和下一段的 offset，接着读就把它传给 offset。',
  parameters: {
    type: 'object',
    properties: {
      offset: { type: 'number', description: '从正文第几个字符开始取（默认 0）。读了上一段之后，用它给的值接着读下一段。' },
    },
    required: [],
  },
  summarize: (args) => (Number(args?.offset) > 0 ? `读取用户 Edge 当前标签（第 ${Number(args.offset)} 字符起）` : '读取用户 Edge 当前标签'),
  async run(args) {
    const cmd = edgeCommand()
    if (!cmd) return '错误：没有连上 Edge 扩展；未读取当前页，也没有改用内置浏览器。'
    let result
    try { result = await cmd.readCurrent({ offset: Number(args?.offset) || 0 }) } catch (error) {
      return `错误：Edge 当前页读取失败：${error instanceof Error ? error.message : String(error)}`
    }
    if (!result?.ok) return `错误：Edge 当前页读取失败：${result?.error?.message ?? result?.error ?? '没有拿到页面内容'}；没有改用内置浏览器。`
    /* 分段信息由 wrapWebText 统一附在正文后面（读不完还要接着读，模型必须知道下一段从哪开始） */
    return wrapWebText({
      source: 'edge',
      url: String(result.url ?? ''),
      title: String(result.title ?? ''),
      text: String(result.text ?? ''),
      truncated: result.truncated === true,
      segments: Number(result.segments) || 1,
      segment: Number(result.segment) || 1,
      nextOffset: result.nextOffset ?? null,
    })
  },
}
