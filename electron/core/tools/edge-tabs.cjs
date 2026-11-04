/*
 * edge_tabs —— 管理**用户自己的 Edge** 的标签页（列 / 搜 / 切 / 新建 / 关）
 *
 * ★★ 两条不可逆的事有硬闸（都在扩展侧 `tabs-run.js`，这里只是入口）：
 *   · `close`：id **必须**在 `list` 里出现过（防编 id 关掉看不见的标签）+ 关完**回读确认**；
 *   · `activate`：同样要求 id 出现在 `list` 里，且**回读确认**前台真的换了。
 *
 * ★ 如实说清的一个边界：manifest **刻意没有 `tabs` 权限**（不默认看全站），
 *   所以只有被授权过的那个标签能读出 url/title，其余如实标 `urlHidden`（不编假的）。
 *
 * ★ 两处「工具层」的门（2026-11-05 P2-3 补的，判据都在别处，这里只调用）：
 *   · `create` 带 url → 先过 `targetGuard`（网络策略的「禁止」+ 站点黑名单的目标判定）；
 *   · `close` 不可逆 → 在「需要确认」档问一次（与 `browse_click` 同口径；
 *     「完全访问」档不问 —— 用户 2026-11-05 拍板）。扩展侧那两道闸（id 必须在
 *     list 里 + 回读确认）一个字都没动，这里是**多**问一次，不是替代它们。
 */

const shared = require('./edge-shared.cjs')
const approvals = require('./approval.cjs')

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
    if (action === 'list') return shared.runEdge('tabsList', {})
    if (action === 'search') return shared.runEdge('tabsSearch', { query: String(args?.query ?? '') })
    if (action === 'activate') return shared.runEdge('tabsActivate', { id: Number(args?.id), ...meta })
    if (action === 'create') {
      const url = String(args?.url ?? '')
      /* 目标地址准入：不给 url（开空白页）就没什么可判的 */
      const blocked = shared.targetGuard(url, ctx)
      if (blocked) return blocked
      return shared.runEdge('tabsCreate', { url, active: args?.active !== false, ...meta })
    }
    if (action === 'close') {
      const id = Number(args?.id)
      /*
       * ★ 关标签**不可逆**（未保存的草稿跟着一起没）：需要确认档先问一次。
       *   「完全访问」档不问 —— 与 `browse_click` 同一口径（用户 2026-11-05 拍板）。
       *   `confirm` 没接线时保持原样（这一族从来就没有确认通道），不擅自改成拒绝：
       *   那会把「完全访问档也能用」这条既有行为改掉。
       */
      if (ctx?.permission === 'ask' && typeof ctx?.confirm === 'function') {
        const approved = await approvals.ask(ctx, {
          kind: 'browser-action',
          name: 'edge_tabs',
          args,
          summary: `关闭你 Edge 里的标签页（id=${Number.isFinite(id) ? id : '(没给)'}）`,
          impact: [
            '这会**关掉你自己浏览器里的一个标签页** —— 关了就回不来',
            '那个标签里没保存的输入 / 草稿会跟着一起消失',
            '只能关「列表里列得出来」的标签：扩展会先核对 id，再回读确认它真的没了',
          ],
          scope: 'once',
        })
        if (approved !== true) {
          /* 以「用户拒绝了」开头：`tools/index.cjs` 靠这个前缀把这次调用记成 ok:false */
          return '用户拒绝了这一步（或确认超时）：**没有关闭任何标签页**，你的浏览器没有被改动。'
        }
      }
      return shared.runEdge('tabsClose', { id, ...meta })
    }
    return `错误：不认识的 action：${action || '(空)'}（可用：list / search / activate / create / close）`
  },
}
