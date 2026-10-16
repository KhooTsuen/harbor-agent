/*
 * edge_scroll —— 滚动**用户自己的 Edge** 的页面
 *
 * 三种滚法：到两端（`to: 'top' | 'bottom'`）/ 按像素（`dy`）/ 滚到某个元素（`ref`）。
 * 证据是 scrollY 的前后值 —— 模型据此知道「到底滚动了没有」。
 */

const { runEdge } = require('./edge-shared.cjs')

module.exports = {
  name: 'edge_scroll',
  description:
    '滚动**用户自己的 Edge** 的页面：到顶部/底部（to）或按像素（dy）；给了 ref 就滚到那个元素。找不到可滚的容器时如实回报。',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', enum: ['top', 'bottom'], description: '滚到最上 / 最下' },
      dy: { type: 'number', description: '相对滚动的像素（正数向下）' },
      ref: { type: 'string', description: '滚到这个元素（edge_page 给的引用）' },
    },
    required: [],
  },

  summarize(args) {
    if (args?.ref) return `滚到元素 ${String(args.ref)}`
    if (args?.to) return `滚到${args.to === 'top' ? '顶部' : '底部'}`
    return `滚动 ${Number(args?.dy ?? 0)} 像素`
  },

  async run(args, ctx) {
    return runEdge('scroll', {
      ref: String(args?.ref ?? ''),
      to: args?.to,
      dy: args?.dy,
      sessionTitleHint: String(ctx?.sessionId ?? ''),
    })
  },
}
