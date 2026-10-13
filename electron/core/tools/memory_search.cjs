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
 * 检索复用 `memory-store.cjs` 的 `search`（关键词**子串**匹配，非向量/非模糊），并按
 * `ctx.projectId` 过滤 —— project 作用域的记忆只在对应项目里搜得到（与注入口径一致）。
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
     * projectId 口径与注入一致：传空串 = 不含 project 作用域的记忆
     * （它们只在对应项目里注入）。`store.search` 已按「非 project 全留 + project 需匹配」过滤。
     */
    const items = memory
      .search(query, { projectId: String(ctx?.projectId ?? '') })
      .filter((item) => item.status === 'active')
      .slice(0, limit)

    if (items.length === 0) return `没搜到与「${query}」有关的记忆。`

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
