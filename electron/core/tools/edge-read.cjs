/** 只读用户 Edge 当前标签的正文；不导航，不使用 Harbor 内置浏览器。 */
const { edgeCommand } = require('./edge-shared.cjs')
const { wrapWebText } = require('./_web-note.cjs')

module.exports = {
  name: 'edge_read',
  description: '读取用户自己的 Edge 当前活动标签正文，不打开新网址。侧边栏里说“读取当前页/这个网页”时使用；失败时如实说明，不改用内置浏览器。',
  parameters: { type: 'object', properties: {}, required: [] },
  summarize: () => '读取用户 Edge 当前标签',
  async run() {
    const cmd = edgeCommand()
    if (!cmd) return '错误：没有连上 Edge 扩展；未读取当前页，也没有改用内置浏览器。'
    let result
    try { result = await cmd.readCurrent() } catch (error) {
      return `错误：Edge 当前页读取失败：${error instanceof Error ? error.message : String(error)}`
    }
    if (!result?.ok) return `错误：Edge 当前页读取失败：${result?.error?.message ?? result?.error ?? '没有拿到页面内容'}；没有改用内置浏览器。`
    return wrapWebText({
      source: 'edge',
      url: String(result.url ?? ''),
      title: String(result.title ?? ''),
      text: String(result.text ?? ''),
      truncated: result.truncated === true,
    })
  },
}
