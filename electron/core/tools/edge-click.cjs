/*
 * edge_click —— 在**用户自己的 Edge**里点一个元素（按 edge_page 给的引用）
 *
 * ★ 三道闸都在里面（不必工具自己记得）：
 *   ① 引用失效（页面变了 / 元素没了）→ **根本不发点击指令**；
 *   ② **提交 / 支付 / 删除这类按钮 → 先弹确认卡**（用户点「允许」才真点）；
 *   ③ 结果带**状态证据**（前后对比）——「点了」≠「生效」。
 */

const { runEdge } = require('./edge-shared.cjs')

module.exports = {
  name: 'edge_click',
  description:
    '在**用户自己的 Edge** 里点一个元素（先用 edge_page 拿到引用）。会做三件事：引用失效就不点；提交/支付/删除这类按钮**先问用户**；点完回报状态证据（页面有没有真的变）。',
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: '元素引用，形如 `60684574.3`（edge_page 给的）' },
      settleMs: { type: 'number', description: '点完等多久再采证据（毫秒，默认 400）' },
    },
    required: ['ref'],
  },

  summarize(args) {
    return `在用户的 Edge 里点元素 ${String(args?.ref ?? '')}`
  },

  async run(args, ctx) {
    return runEdge('click', {
      ref: String(args?.ref ?? ''),
      settleMs: Number(args?.settleMs) || 0,
      sessionTitleHint: String(ctx?.sessionId ?? ''),
    })
  },
}
