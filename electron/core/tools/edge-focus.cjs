/*
 * edge_focus —— 聚焦**用户自己的 Edge** 里的元素
 *
 * 什么时候需要它：输入法、需要真实按键的控件（先聚焦再 `edge_key`）、
 * 以及某些「失焦才校验」的表单。
 *
 * 证据是**前后焦点元素的可读名字** —— 能看出「焦点到底给到了谁」。
 */

const { runEdge } = require('./edge-shared.cjs')

module.exports = {
  name: 'edge_focus',
  description:
    '把焦点给**用户自己的 Edge** 里的某个元素（edge_page 给的引用）。输入法、真实按键、失焦校验这类场景需要先聚焦。',
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: '要聚焦的元素引用（edge_page 给的）' },
    },
    required: ['ref'],
  },

  summarize(args) {
    return `聚焦元素 ${String(args?.ref ?? '')}`
  },

  async run(args, ctx) {
    return runEdge('focus', {
      ref: String(args?.ref ?? ''),
      sessionTitleHint: String(ctx?.sessionId ?? ''),
    })
  },
}
