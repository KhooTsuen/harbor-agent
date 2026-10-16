/*
 * edge_type —— 往**用户自己的 Edge** 的输入框里填文本
 *
 * ★ 两条边界（在扩展侧先判、先拒，一个字节都不写）：
 *   · 密码框（`type=password`）
 *   · 信用卡字段（`autocomplete` 以 `cc-` 开头）
 *   拒绝时明确回「页面没有被改动」，并让用户**自己输入**。
 *
 * ★ 填的是「值」，不是逐字敲键盘 —— 需要真实按键（Enter / Tab）用 `edge_key`。
 */

const { runEdge } = require('./edge-shared.cjs')

module.exports = {
  name: 'edge_type',
  description:
    '往**用户自己的 Edge** 的输入框里填文本（先用 edge_page 拿到引用）。**不填 text 就是清空**这个输入框。★ 密码框和信用卡字段会被**拒绝**（一个字节都不写，请用户自己输入）。要按 Enter / Tab 这类真实按键，用 edge_key。',
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: '输入框的引用（edge_page 给的）' },
      text: { type: 'string', description: '要填的文本；**不填 = 清空**这个输入框' },
      clear: { type: 'boolean', description: '填之前先清空（默认 true）。传 false 是追加' },
    },
    required: ['ref'],
  },

  summarize(args) {
    const t = String(args?.text ?? '')
    return `往输入框填「${t.length > 20 ? `${t.slice(0, 20)}…` : t}」`
  },

  async run(args, ctx) {
    return runEdge('type', {
      ref: String(args?.ref ?? ''),
      text: String(args?.text ?? ''),
      clear: args?.clear !== false,
      sessionTitleHint: String(ctx?.sessionId ?? ''),
    })
  },
}
