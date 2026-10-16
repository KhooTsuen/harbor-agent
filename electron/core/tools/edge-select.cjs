/*
 * edge_select —— 在**用户自己的 Edge** 里选下拉框的值
 *
 * 三种指定方式（给一个即可）：`value`（选项的值）/ `label`（显示文本）/ `index`（第几项）。
 * 找不到时**把可选值全列出来** —— 不然只能瞎猜下一次试什么。
 */

const { runEdge } = require('./edge-shared.cjs')

module.exports = {
  name: 'edge_select',
  description:
    '在**用户自己的 Edge** 里选一个下拉框的值（<select>，先用 edge_page 拿到引用）。按 value / label / index 任一指定。找不到这个选项时会把**所有可选值列出来**。',
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: '下拉框的引用（edge_page 给的）' },
      value: { type: 'string', description: '选项的值（<option value="…">）' },
      label: { type: 'string', description: '选项的显示文本' },
      index: { type: 'number', description: '第几项（从 0 起）' },
    },
    required: ['ref'],
  },

  summarize(args) {
    return `选下拉框：${args?.value ?? args?.label ?? `第 ${args?.index ?? 0} 项`}`
  },

  async run(args, ctx) {
    return runEdge('select', {
      ref: String(args?.ref ?? ''),
      value: args?.value,
      label: args?.label,
      index: args?.index,
      sessionTitleHint: String(ctx?.sessionId ?? ''),
    })
  },
}
