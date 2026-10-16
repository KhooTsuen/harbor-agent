/*
 * edge_wait —— 等**用户自己的 Edge** 的页面满足某个条件
 *
 * ★ `timeoutMs: 0` 就是「**立刻验一次**」—— 语义等价于「验证」，所以**不另做 verify 工具**
 *   （两个语义相同的工具只会让模型犹豫）。
 *
 * ★ 条件复用 `browser.verify` 的写法（`core/ext-actions.cjs` 的 `wait` 在扩展侧轮询
 *   同一份 `verifyPage`）—— 条件语义只有那一处实现。
 */

const { runEdge } = require('./edge-shared.cjs')

module.exports = {
  name: 'edge_wait',
  description:
    '等**用户自己的 Edge** 的页面满足条件（元素出现/消失、文本包含、URL 匹配），带超时。`timeoutMs: 0` = 立刻检查一次（相当于「验证当前状态」）。等不到不算报错，会如实说「没变成你等的那个样子」。',
  parameters: {
    type: 'object',
    properties: {
      expect: {
        type: 'object',
        description:
          '期望（至少给一条）：text（正文包含）/ textGone（正文不含）/ selector（选择器出现）/ selectorGone（选择器消失）/ url（地址包含）/ urlIs（地址完全等于）',
      },
      timeoutMs: { type: 'number', description: '最多等多少毫秒（默认 10000；0 = 只检查一次）' },
    },
    required: ['expect'],
  },

  summarize(args) {
    const e = args?.expect && typeof args.expect === 'object' ? args.expect : {}
    const k = Object.keys(e)[0]
    return k ? `等条件：${k} = ${String(e[k])}` : '等页面条件'
  },

  async run(args, ctx) {
    const expect = args?.expect && typeof args.expect === 'object' ? args.expect : {}
    if (!Object.keys(expect).length) return '错误：没给要等的条件 —— 至少给一条（见 expect 的写法）。'
    return runEdge('wait', {
      expect,
      timeoutMs: args?.timeoutMs === 0 ? 1 : Number(args?.timeoutMs) || 10000,
      sessionTitleHint: String(ctx?.sessionId ?? ''),
    })
  },
}
