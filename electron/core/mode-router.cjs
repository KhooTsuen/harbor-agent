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

/* ══════════════════════════════════════════════════════════════
   CE-005：任务感知的 persona（两级 · 纯正则，不调 LLM）

   「同一个模型在不同任务上表现差异巨大」——参考 dsh-routing-suite 的实测结论
   （见 docs/research/phase6-governance-routing-design.md §1/§2）。Harbor 取它
   最稳的两端，先不做三带相变：

     strong 强档 —— 要先想清楚、要细读的活（规划 / 架构 / 重构 / 根因 / 多文件改动）
     fast   快档 —— 目标明确、一两步到位的活（问个事实、改一处小的、打个招呼）

   ★ 为什么不另写一套规则：`resolve` 已经把「这句话是什么意图」判完了（一份
     RULES、一处真相源）。persona 只是**同一判定结果的另一种解读**，所以这里
     只做 mode → persona 的映射，不再抄一份正则（抄两份迟早会漂，硬约束 #9）。
     `MODE_PERSONA` 必须覆盖 `RULES` 里出现的**每一个** mode —— 有自检盯着（142 组）。

   ★ 首轮锁定：调用方传的是**第一条真实用户消息**（见 loop-route.personaOf）。
     纯函数 ⇒ 同一句话永远得同一个结果，所以「锁定」不需要任何状态、不落盘、
     不改任务台账结构。中途想换 persona 只能靠 spawn_subagent 另起一条会话。
   ══════════════════════════════════════════════════════════════ */
const MODE_PERSONA = {
  think: 'strong',
  research: 'strong',
  agent: 'strong',
  code: 'strong',
  creative: 'fast',
  chat: 'fast',
}

/** 默认档：没命中强档信号时回退它（低风险、省 token，和 resolve 的 chat 兜底一致） */
const DEFAULT_PERSONA = 'fast'

/**
 * 这句话属于哪一档 persona。
 *
 * @param {string} text   第一条真实用户消息（persona 锁定用；单轮也可以传当前这句）
 * @param {string} forced 手动指定 mode（'' = 自动）—— 与 resolve 同口径
 * @returns {{ persona: 'strong'|'fast', mode: string, confidence: number, reason: string }}
 */
function personaFor(text = '', forced = '') {
  const decision = resolve(text, forced)
  return {
    persona: MODE_PERSONA[decision.mode] ?? DEFAULT_PERSONA,
    mode: decision.mode,
    confidence: decision.confidence,
    reason: decision.reason,
  }
}

module.exports = { resolve, RULES, personaFor, MODE_PERSONA, DEFAULT_PERSONA }
