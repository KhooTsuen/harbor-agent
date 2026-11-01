/**
 * memory_search —— 让模型**读**长期记忆（只读工具）
 *
 * ★ 为什么需要它：记忆每轮只把「最相关的那几条」注入系统提示，模型**看不到**其余条目，
 *   也没有任何「取更多」的入口。设置页那个 `memory:search` 是 **IPC 通道**
 *   （`handlers/extras.cjs` → `preload.cjs` 的 `memorySearch`），只在渲染层（人）手里，
 *   模型侧**够不着** —— `tools/` 里此前只有「写记忆」的 `remember`，没有「读记忆」的。
 *   这个工具就是给模型补上那只「读的手」：按关键词搜记忆库、拿回完整内容。
 *
 * ★ 三条边界（不可越）：
 *   ① **只读**：不写盘、不联网、不跑命令 → **不进 `WRITE_TOOLS`**（放进去 ask 档每次搜索
 *      都弹确认框，功能没法用；同 `mark_step_done` 的教训）。readonly 档照样能用。
 *   ② **查询为空不抛异常**：返回错误文本让模型自己纠正（抛了会炸掉模型循环）。
 *   ③ **类型标签只有一处**：直接引用 `memory-explain.cjs` 的 `TYPE_LABEL`，不在这里再抄
 *      一份（AGENT.md 硬约束 9：跨模块约定只有一处真相源）。
 *
 * 检索复用 `memory-store.cjs` 的 `search`（关键词**子串**匹配，非向量/非模糊），
 * 并按 `ctx.projectId` + `ctx.sessionId` 过滤 —— 判据只有一处（`core/memory-scope.cjs`），
 * 与每轮自动注入口径**完全相同**（P0-4：此前这里只认 projectId，于是 B 会话能搜到
 * A 会话的私有记忆，注入路径却拦着 —— 两个入口说的不是同一件事）。
 * 设计见 `docs/research/memory-layered-recall-design.md`。
 */

const memory = require('../memory.cjs')
const { TYPE_LABEL } = require('../memory-explain.cjs')

/** 一次最多返回几条（模型要更多可以再搜；防止一次性把上下文灌爆） */
const MAX_RESULTS = 20
const DEFAULT_RESULTS = 10

module.exports = {
  name: 'memory_search',
  description: [
    '搜索长期记忆，拿回匹配条目的**完整内容**（只读）。',
    '系统提示里只注入了每轮最相关的那几条；当你想确认某个约定 / 偏好 / 事实是否被记录过，',
    '或需要记忆条目的更多细节时，用它按关键词搜。',
    `query 必填（关键词，中英文都行）；limit 可选（默认 ${DEFAULT_RESULTS}，最大 ${MAX_RESULTS}）。`,
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词，比如「下载目录」「严格模式」「打包」。匹配记忆的内容 / 类型 / 范围。',
      },
      limit: {
        type: 'integer',
        description: `最多返回几条（默认 ${DEFAULT_RESULTS}，最大 ${MAX_RESULTS}）。`,
      },
    },
    required: ['query'],
  },

  async run(args, ctx = {}) {
    const query = String(args?.query ?? '').trim()
    if (!query) return '错误：query 是空的，请给一个关键词再搜。'

    const rawLimit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : DEFAULT_RESULTS
    const limit = Math.min(rawLimit, MAX_RESULTS)

    /*
     * projectId / sessionId 口径与注入完全一致（P0-4，判据只有一处：
     * `core/memory-scope.cjs`），别在这里另写一套过滤。
     * 传空串 = 这个上下文没有该项目 / 会话 → 该域的私有条目不可见。
     * 以前只传 projectId，于是从 B 会话能搜到 A 会话的私事 —— 而注入路径拦着。
     */
    const items = memory
      .search(query, {
        projectId: String(ctx?.projectId ?? ''),
        sessionId: String(ctx?.sessionId ?? ''),
      })
      .filter((item) => item.status === 'active')
      .slice(0, limit)

    if (items.length === 0) {
      return `当前可见范围内没搜到与「${query}」有关的记忆（别的会话 / 别的项目的私有记忆不在这里）。`
    }

    const lines = items.map((item) => {
      const tag = TYPE_LABEL[item.type] ?? '记忆'
      return `- [${tag}] ${item.content}（id: ${item.id}）`
    })

    return `搜到 ${items.length} 条与「${query}」有关的记忆：\n${lines.join('\n')}`
  },

  summarize(args) {
    const q = String(args?.query ?? '').trim()
    return q ? `搜索记忆：${q.slice(0, 30)}` : '搜索记忆'
  },
}
