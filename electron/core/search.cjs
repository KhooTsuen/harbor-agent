/**
 * 联网搜索
 *
 * 四个后端，统一成 [{ title, url, snippet }]：
 *   · tavily     —— 质量好，需要 key
 *   · bocha      —— 国内可用，需要 key
 *   · duckduckgo —— 免费无需 key（但所在网络要能通）
 *   · custom     —— 用户自己填 URL 模板
 *
 * 为什么要多后端：国内网络下 DuckDuckGo 经常不通，而 Tavily 要付费。
 * 让用户按自己的网络情况选，比写死一个好。
 */

const http = require('./http.cjs')
const searchCache = require('./search-cache.cjs')
const log = require('./log.cjs')

const TIMEOUT_MS = 20_000

async function fetchJson(url, init = {}, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const res = await http.fetch(url, { ...init, signal: controller.signal })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}：${detail.slice(0, 200)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function fetchText(url, init = {}, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const res = await http.fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36',
        ...(init.headers ?? {}),
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 把 HTML 实体粗解一下（搜索结果里 &amp; &#39; 很常见） */
function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/* ══════════════════════════════════════════════════════════════
   各后端
   ══════════════════════════════════════════════════════════════ */

async function tavily(query, opts) {
  if (!opts.apiKey) throw new Error('Tavily 需要 API Key')
  const data = await fetchJson(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: opts.apiKey,
        query,
        max_results: opts.maxResults,
        search_depth: 'basic',
      }),
    },
    opts.signal,
  )
  const list = Array.isArray(data?.results) ? data.results : []
  return list.map((item) => ({
    title: String(item.title ?? ''),
    url: String(item.url ?? ''),
    snippet: String(item.content ?? '').slice(0, 400),
  }))
}

async function bocha(query, opts) {
  if (!opts.apiKey) throw new Error('博查需要 API Key')
  const data = await fetchJson(
    'https://api.bochaai.com/v1/web-search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({ query, count: opts.maxResults, summary: true }),
    },
    opts.signal,
  )
  const list = data?.data?.webPages?.value
  if (!Array.isArray(list)) return []
  return list.map((item) => ({
    title: String(item.name ?? ''),
    url: String(item.url ?? ''),
    snippet: String(item.summary ?? item.snippet ?? '').slice(0, 400),
  }))
}

async function duckduckgo(query, opts) {
  const html = await fetchText(
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    {},
    opts.signal,
  )

  const out = []
  /* lite 版结构：<a ... class="result-link" href="...">标题</a> 配 <td class="result-snippet"> */
  const linkRe = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g

  const snippets = []
  let sm
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]))

  let lm
  let index = 0
  while ((lm = linkRe.exec(html)) !== null && out.length < opts.maxResults) {
    out.push({
      title: stripTags(lm[2]),
      url: decodeEntities(lm[1]),
      snippet: snippets[index++] ?? '',
    })
  }
  return out
}

async function custom(query, opts) {
  const template = String(opts.endpoint ?? '').trim()
  if (!template) throw new Error('自定义搜索需要填 URL 模板，用 {query} 占位')

  const url = template.includes('{query}')
    ? template.replace(/\{query\}/g, encodeURIComponent(query))
    : `${template}${encodeURIComponent(query)}`

  const text = await fetchText(url, {}, opts.signal)

  /* 先按 JSON 试，不行再当 HTML 抓 */
  try {
    const data = JSON.parse(text)
    const list = Array.isArray(data) ? data : (data.results ?? data.items ?? data.data ?? [])
    if (Array.isArray(list)) {
      return list.slice(0, opts.maxResults).map((item) => ({
        title: String(item.title ?? item.name ?? ''),
        url: String(item.url ?? item.link ?? ''),
        snippet: String(item.snippet ?? item.content ?? item.summary ?? '').slice(0, 400),
      }))
    }
  } catch {
    /* 不是 JSON，按 HTML 处理 */
  }

  const out = []
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  let m
  while ((m = re.exec(text)) !== null && out.length < opts.maxResults) {
    const title = stripTags(m[2])
    if (!title || title.length < 3) continue
    out.push({ title, url: decodeEntities(m[1]), snippet: '' })
  }
  return out
}

/* ══════════════════════════════════════════════════════════════
   对外
   ══════════════════════════════════════════════════════════════ */

const PROVIDERS = {
  tavily: { label: 'Tavily', needKey: true, run: tavily },
  bocha: { label: '博查', needKey: true, run: bocha },
  duckduckgo: { label: 'DuckDuckGo', needKey: false, run: duckduckgo },
  custom: { label: '自定义', needKey: false, run: custom },
}

function providerList() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, needKey: p.needKey }))
}

/**
 * 执行一次搜索。
 *
 * @param {string} query
 * @param {object} options { provider, apiKey, endpoint, maxResults, signal, fresh }
 * @returns {Promise<{results: Array, cached: boolean, ageMs: number}>}
 *
 * 返回值里带 `cached` / `ageMs` —— 调用方（`formatResults`）要把「这是几分钟前的
 * 结果」告诉模型。缓存本身没错，但**默默给旧结果**就不行：模型不知道自己在看
 * 旧东西，就不会想「要不要重搜」。
 */
async function search(query, options) {
  const text = String(query ?? '').trim()
  if (!text) throw new Error('搜索词不能为空')

  const id = PROVIDERS[options.provider] ? options.provider : 'duckduckgo'
  const provider = PROVIDERS[id]
  const maxResults = Math.min(10, Math.max(1, Number(options.maxResults) || 5))

  /*
   * AG-020：同样的 provider + 查询词 + 数量 → 直接给缓存。
   * 搜索走网络、部分 provider 还按次收费，重复搜同一个词是白花钱。
   * 失效只有 TTL（10 分钟）—— 外部世界随时在变，我们没有 mtime 那种判据。
   *
   * `fresh: true` 跳过缓存（用新结果覆盖）—— 因为「TTL 该定几分钟」这个问题
   * **本来就设有答案**，与其拍一个数字，不如把决定权交给模型：
   * 搜「胡斯战争是哪年」用缓存没问题，搜「今天有什么新闻」自己带 fresh。
   */
  if (!options.fresh) {
    const hit = searchCache.get(id, text, maxResults)
    if (hit.hit) {
      const seconds = Math.round((hit.age ?? 0) / 1000)
      log.info(`搜索「${text}」命中缓存（${seconds}s 前的结果）`)
      return { results: hit.value, cached: true, ageMs: hit.age ?? 0 }
    }
  }

  log.info(`搜索「${text}」via ${provider.label}${options.fresh ? '（fresh，跳过缓存）' : ''}`)

  const results = await provider.run(text, { ...options, maxResults })
  const out = results.filter((r) => r.url).slice(0, maxResults)
  searchCache.put(id, text, maxResults, out, { source: provider.label })
  return { results: out, cached: false, ageMs: 0 }
}

/**
 * 给结果编号 —— 模型回答时能引用「来源 [2]」，用户能对得上。
 * 不带编号的话，多来源的回答就只能说「根据搜索结果」，等于没引用。
 */
function withCitations(results) {
  return results.map((item, index) => ({ ...item, citationId: index + 1 }))
}

/**
 * 把结果转成给模型看的文本。
 *
 * `meta` 带缓存命中信息时，**在开头明确告诉模型「这是 N 分钟前搜到的」** ——
 * 默默给它旧结果是不行的：它不知道自己在看旧东西，就不会想「要不要重搜」。
 * 顺带把「怎么绕过缓存」也写清楚（`fresh` 参数），它自己就能决定。
 */
function formatResults(query, results, meta = {}) {
  if (results.length === 0) {
    return `搜索「${query}」没有结果。可能搜索词太窄，换个说法再试；或者当前搜索服务不通（设置 → 搜索里可以换一个）。`
  }

  const lines = [`搜索「${query}」的结果：`]
  if (meta.cached) {
    const age = Number(meta.ageMs) || 0
    const when =
      age < 90 * 1000
        ? `${Math.max(1, Math.round(age / 1000))} 秒前`
        : `${Math.round(age / 60000)} 分钟前`
    lines.push('')
    lines.push(
      `（这些是**${when}**搜到的，直接复用了缓存。如果是时效敏感的东西（最新版本、当前价格、今天发生了什么），` +
        `用 search_web 带上 fresh=true 重新搜。）`,
    )
  }
  lines.push('')
  results.forEach((item, i) => {
    lines.push(`${i + 1}. ${item.title}`)
    lines.push(`   ${item.url}`)
    if (item.snippet) lines.push(`   ${item.snippet}`)
    lines.push('')
  })
  lines.push('要用某一条的内容，用 fetch 不了的地址就别猜 —— 引用时把 URL 一起给出来。')
  return lines.join('\n')
}

module.exports = { search, formatResults, providerList, PROVIDERS, searchCache }
