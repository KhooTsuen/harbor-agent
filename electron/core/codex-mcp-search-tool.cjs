/** Search only through Harbor's configured provider; callers cannot choose endpoints or credentials. */
const MAX_QUERY = 2000
const TOOL = {
  name: 'harbor_search_web',
  description: '使用 Harbor 已配置的搜索服务检索并返回真实来源。仅当前有效对话且允许联网时可用；不接受网址、搜索端点或凭据配置。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: MAX_QUERY, description: '搜索关键词' },
      maxResults: { type: 'integer', minimum: 1, maximum: 20, description: '结果条数，缺省沿用搜索设置' },
      fresh: { type: 'boolean', description: '强制更新搜索，时效敏感任务使用 true' },
    },
    required: ['query'],
    additionalProperties: false,
  },
}

function cleanSearch(args) {
  const raw = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  if (typeof raw.query !== 'string' || !raw.query.trim())
    return { ok: false, message: 'query 必填，且必须是非空字符串' }
  if (raw.query.length > MAX_QUERY)
    return { ok: false, message: `query 过长（上限 ${MAX_QUERY} 字符）` }
  const clean = { query: raw.query.trim() }
  if (raw.maxResults !== undefined) {
    if (!Number.isInteger(raw.maxResults) || raw.maxResults < 1 || raw.maxResults > 20)
      return { ok: false, message: 'maxResults 必须是 1–20 之间的整数' }
    clean.maxResults = raw.maxResults
  }
  if (raw.fresh !== undefined) {
    if (typeof raw.fresh !== 'boolean') return { ok: false, message: 'fresh 必须是布尔值' }
    clean.fresh = raw.fresh
  }
  return { ok: true, args: clean }
}

module.exports = { TOOL, cleanSearch }
