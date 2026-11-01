/**
 * 历史回放：把「跑过的工具」还原成结构化的 assistant(tool_calls) + tool 消息（2026-10-21）
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────
 *
 * 以前工具记录是**拼进正文**的：
 *
 *     content += `\n\n[此前工具执行记录]\n${replay}`
 *
 * 后果不是排版难看，而是**内容归属错乱** —— 真机量出来的：
 * 一条 37,898 字符的回答里，第 34 轮独占 36,477 字，其中 31,215 字是
 * 52 次工具调用的原始输出（合计 70,493 字）。模型在历史里反复看到
 * 「assistant 消息后面挂一段工具清单」，就把它当成**回答该有的格式**照着复述，
 * 界面上就是「一整块几乎没有分段的连续文字」。
 *
 * 现在改成协议层的结构化形状 —— 与本轮上传工具结果**一直用的**形状一致
 * （`loop.cjs` 的 `tool_calls` + `tool-runner.cjs` 的 `{role:'tool', tool_call_id}`）。
 * 此前只有「跨会话历史」这一处还在用文本拼，属于同一约定两套写法。
 *
 * ── 两条路必须同形 ──────────────────────────────────────────
 *
 * 这个模块被两处调用，喂给模型的**必须**是同一种形状，否则「刚聊完」和
 * 「重开会话」模型看到的东西不一样：
 *   · `electron/core/session-read.cjs` 的 `toApiMessages`（从磁盘读历史）
 *   · `src/stores/thread/history.ts` 的 `buildHistory`（渲染层把内存历史发过去）
 *
 * 渲染层那份是 TypeScript，import 不了 `.cjs`，所以形状规则写在**两边注释**里，
 * 由 `scripts/selftest/groups/01-basics.mjs` 钉住主进程那份。
 *
 * ── ★ id 怎么来（最容易踩的一条）───────────────────────────────
 *
 * 老记录里没有真实 `toolCallId`（`toolRuns[].id` 是渲染层生成的，不是上游给的）。
 * 所以这里**合成**回放 id —— 只要 assistant 的 `tool_calls[].id` 与自己发出的
 * tool 消息 `tool_call_id` **逐字相同**，协议就自洽，模型不需要真 id。
 *
 * 合成规则必须**可重复**：同一份历史每次回放得到同样的 id，否则上游的
 * 前缀缓存（prefix cache）每次都失效，长对话会明显变慢。
 */

/** 单条工具输出在历史里的上限（原样保留，与改动前一致） */
const OUTPUT_CAP = 2000

/**
 * 造一对「assistant(tool_calls) + tool」消息。
 *
 * @param {{ content?: string | Array<object> }} base 那条助手消息的正文（没有工具时就是一条普通消息）
 * @param {Array<{ name?: string, ok?: boolean, output?: string }>} runs 工具记录
 * @param {string} seed 稳定种（会话里那条记录的 key / diskKey）—— 保证可重复
 * @returns {Array<object>} 至少一条（没有 runs 时返回一条普通 assistant）
 */
function replayToolRuns(base, runs, seed) {
  const content = typeof base?.content === 'string' || Array.isArray(base?.content) ? base.content : ''
  const list = Array.isArray(runs) ? runs : []
  if (list.length === 0) return [{ role: 'assistant', content }]

  const suffix = String(seed ?? '').slice(-8) || 'r'
  const callIdOf = (k) => `replay_${suffix}_${k}`

  const assistant = {
    role: 'assistant',
    content,
    tool_calls: list.map((tool, k) => ({
      id: callIdOf(k),
      type: 'function',
      /*
       * `arguments` 必须是**合法 JSON 字符串**（不是对象）。
       * 老记录里没存原始参数，给空对象 —— 摘要已经在下面 tool 消息的正文里，
       * 模型照样知道这一步干了什么。编一份假参数比给空对象更糟（它会当真）。
       */
      function: { name: String(tool?.name ?? 'tool'), arguments: '{}' },
    })),
  }

  const toolMessages = list.map((tool, k) => ({
    role: 'tool',
    tool_call_id: callIdOf(k),
    content:
      `${tool?.name ?? 'tool'}: ${tool?.ok === false ? '失败' : '成功'}` +
      `${tool?.output ? `\n${String(tool.output).slice(0, OUTPUT_CAP)}` : ''}`,
  }))

  return [assistant, ...toolMessages]
}

module.exports = { replayToolRuns, OUTPUT_CAP }
