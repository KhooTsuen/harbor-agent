/** CE-004：只做意图与模式判断，不授予权限。 */
const RULES = [
  { mode: 'research', patterns: [/最新|现在|目前|查一下|搜索|资料|来源|研究/] },
  { mode: 'creative', patterns: [/歌词|故事|小说|创意|概念|文案|设计一个/] },
  { mode: 'agent', patterns: [/帮我完成|实现|修改|修复|重构|执行|跑一下|创建/] },
  { mode: 'code', patterns: [/代码|函数|组件|接口|测试|报错|bug|debug|仓库|项目/] },
  { mode: 'think', patterns: [/分析|为什么|原因|架构|权衡|方案|复杂/] },
]
function resolve(text = '', forced = '') {
  if (forced && forced !== 'auto') return { mode: forced, confidence: 1, reason: '用户手动指定' }
  const value = String(text)
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(value))) {
      return { mode: rule.mode, confidence: 0.86, reason: `命中${rule.mode}意图规则` }
    }
  }
  return { mode: 'chat', confidence: 0.65, reason: '未命中特殊意图，低风险回退到聊天' }
}
module.exports = { resolve, RULES }
