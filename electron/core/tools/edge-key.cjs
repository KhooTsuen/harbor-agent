/*
 * edge_key —— 往**用户自己的 Edge** 派发键盘事件（Enter / Tab / Escape…）
 *
 * `edge_type` 是「把值设进去」，有些组件**只认键盘**（在 keydown 上提交、Escape 关弹窗）。
 * 这个工具补的就是那一类。
 *
 * `ref` 可空：空 = 派给**当前焦点元素**（Escape 这类挂在 document 上的监听就是这么用的）。
 */

const { runEdge } = require('./edge-shared.cjs')

module.exports = {
  name: 'edge_key',
  description:
    '往**用户自己的 Edge** 派发一次键盘事件（如 Enter / Tab / Escape）。给了 ref 就先聚焦它；不给就派给当前焦点元素（Escape 关弹窗这类用这个）。三种键盘事件（keydown/keypress/keyup）都会派。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '键名：Enter / Tab / Escape / ArrowDown …（不填默认 Enter）' },
      ref: { type: 'string', description: '先聚焦这个元素（edge_page 给的引用）；不填 = 当前焦点' },
    },
    required: [],
  },

  summarize(args) {
    return `按 ${String(args?.key ?? 'Enter')}${args?.ref ? `（先聚焦 ${args.ref}）` : ''}`
  },

  async run(args, ctx) {
    return runEdge('key', {
      ref: String(args?.ref ?? ''),
      key: String(args?.key ?? 'Enter'),
      sessionTitleHint: String(ctx?.sessionId ?? ''),
    })
  },
}
