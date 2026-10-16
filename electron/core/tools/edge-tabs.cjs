/*
 * edge_tabs —— 管理**用户自己的 Edge** 的标签页（列 / 搜 / 切 / 新建 / 关）
 *
 * ★★ 两条不可逆的事有硬闸（都在扩展侧 `tabs-run.js`，这里只是入口）：
 *   · `close`：id **必须**在 `list` 里出现过（防编 id 关掉看不见的标签）+ 关完**回读确认**；
 *   · `activate`：同样要求 id 出现在 `list` 里，且**回读确认**前台真的换了。
 *
 * ★ 如实说清的一个边界：manifest **刻意没有 `tabs` 权限**（不默认看全站），
 *   所以只有被授权过的那个标签能读出 url/title，其余如实标 `urlHidden`（不编假的）。
 */

const { runEdge } = require('./edge-shared.cjs')

const ACTIONS = {
  list: '列出标签页',
  search: '搜标签页',
  activate: '切到某个标签页',
  create: '新建标签页',
  close: '关闭标签页',
}

module.exports = {
  name: 'edge_tabs',
  description:
    '管理**用户自己的 Edge** 的标签页。action=list 列出能操作的标签（含 id / 标题 / 地址）；search 按标题或地址搜（给 query）；activate 切到某个（给 id）；create 新建（给 url，可不给）；close 关闭（给 id，**不可逆**，会先确认那个标签确实在列表里）。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'search', 'activate', 'create', 'close'],
        description: '要做什么',
      },
      id: { type: 'number', description: '标签 id（activate / close 必需；来自 list）' },
      query: { type: 'string', description: '搜索词（search 必需）' },
      url: { type: 'string', description: '新标签的地址（create 可选；不填开空白页）' },
      active: { type: 'boolean', description: '新建后是否切过去（create 可选，默认 true）' },
    },
    required: ['action'],
  },

  summarize(args) {
    const a = String(args?.action ?? '')
    const label = ACTIONS[a] ?? `标签页操作 ${a}`
    if (a === 'search') return `${label}：${String(args?.query ?? '')}`
    if (a === 'activate' || a === 'close') return `${label}（id=${String(args?.id ?? '')}）`
    if (a === 'create') return `${label}：${String(args?.url ?? '（空白页）')}`
    return label
  },

  async run(args, ctx) {
    const action = String(args?.action ?? '')
    const meta = { sessionTitleHint: String(ctx?.sessionId ?? '') }
    if (action === 'list') return runEdge('tabsList', {})
    if (action === 'search') return runEdge('tabsSearch', { query: String(args?.query ?? '') })
    if (action === 'activate') return runEdge('tabsActivate', { id: Number(args?.id), ...meta })
    if (action === 'create') {
      return runEdge('tabsCreate', { url: String(args?.url ?? ''), active: args?.active !== false, ...meta })
    }
    if (action === 'close') return runEdge('tabsClose', { id: Number(args?.id), ...meta })
    return `错误：不认识的 action：${action || '(空)'}（可用：list / search / activate / create / close）`
  },
}
