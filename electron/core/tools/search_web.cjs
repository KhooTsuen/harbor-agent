const search = require('../search.cjs')
const config = require('../config.cjs')

/**
 * search_web —— 联网搜索
 *
 * 用哪个后端、要不要 key，都在「设置 → 搜索」里配。
 * 工具本身不关心这些，配置不对时给出明确的错误指引。
 */
module.exports = {
  name: 'search_web',
  description:
    '联网搜索（轻量 HTTP，快但拿不到 JavaScript 渲染出来的内容）。当用户问到你的知识里没有、或者可能已经变了的东西（库的新版本、报错信息、别人的做法、商品价格）时**先用它**。搜完把 URL 一起给出来，方便用户自己核对。如果某个结果看起来是关键但搜到的摘要不够，用 browse 打开那一页读正文。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索词。用关键词，别写整句话' },
      maxResults: { type: 'integer', description: '要几条结果，默认按设置（一般 5）' },
      fresh: {
        type: 'boolean',
        description:
          '强制重新联网搜，不用缓存。默认 false。搜**时效敏感**的东西（最新版本、当前价格、今天发生了什么）时设 true；查稳定的知识（历史、语法、某个库的基本用法）不用设。缓存结果会在开头标明是多久以前的。',
      },
    },
    required: ['query'],
  },

  async run(args, ctx) {
    const settings = config.get().search
    const apiKey = config.searchKey()

    /* 明确说清该怎么修，而不是只说「失败了」 */
    if (settings.provider === 'tavily' && !apiKey) {
      throw new Error(
        '当前用 Tavily 但没填 API Key。去「设置 → 搜索」填一下，或者换成 DuckDuckGo。',
      )
    }
    if (settings.provider === 'bocha' && !apiKey) {
      throw new Error('当前用博查但没填 API Key。去「设置 → 搜索」填一下，或者换成 DuckDuckGo。')
    }
    if (settings.provider === 'custom' && !settings.endpoint) {
      throw new Error(
        '当前用自定义搜索但没填 URL 模板。去「设置 → 搜索」填上，模板里用 {query} 占位。',
      )
    }

    const found = await search.search(String(args.query ?? ''), {
      provider: settings.provider,
      apiKey,
      endpoint: settings.endpoint,
      maxResults: Number(args.maxResults) || settings.maxResults,
      signal: ctx?.signal,
      fresh: args.fresh === true,
    })

    return search.formatResults(String(args.query ?? ''), found.results, found)
  },

  summarize(args) {
    return `搜索：${String(args.query ?? '').slice(0, 60)}`
  },
}
