import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   AG-020：Context Cache

   文档点名六项：Project Tree / File Metadata / Recent File Content /
   Search Results / Tool Results / Conversation State。

   ★ 实际只做了**两项**（最近文件内容 AG-019 已做、搜索结果这轮做），
     其余四项**有意不做**，理由是对应的收益/风险不成比例：

     · File Metadata  —— `stat` 就是几微秒，缓存它没意义
     · Tool Results   —— 同工具同参数结果**可能不同**（时间/随机/外部状态）；
                          而且「重复调同一个工具」本身就是病态行为，
                          缓存会**掩盖**它（那正是 AG-041 要抓的）
     · Project Tree   —— 前端只在开右栏时拉（频率低），而缓存会让
                          「刚改的文件看不到变化」；实时性 > 那点 IO
     · Conversation State —— 它**是状态不是缓存**（有真相源、每轮更新）

   所以这一组的守卫主要是「**通用件抽对了**」+「**做了的那两项确实生效**」。
   ══════════════════════════════════════════════════════════════ */

const { createCache } = require(join(ROOT, 'electron/core/cache.cjs'))
const searchCache = require(join(ROOT, 'electron/core/search-cache.cjs'))

const readCore = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  group('AG-020 · Context Cache')

  /* ── 通用缓存：TTL / 容量 / 自定义失效 / 统计 ── */
  const c = createCache({ name: 'test', max: 3, defaultTtl: 1000 })
  check('没存过时不命中', c.get('a').hit === false)
  c.put('a', 1, { source: 'unit' })
  const got = c.get('a')
  check('存过之后命中', got.hit === true)
  check('拿到的是存进去的值', got.value === 1)
  check(
    'entry 上有 createdAt/updatedAt/ttl/source（文档点名）',
    (() => {
      const e = got.entry
      return e.createdAt > 0 && e.updatedAt > 0 && e.ttl > 0 && e.source === 'unit'
    })(),
  )

  /* 容量：超过 max 淘汰最老的 */
  c.put('b', 2)
  c.put('c', 3)
  c.put('d', 4)
  check('★ 超出上限会淘汰最老的', c.get('a').hit === false)
  check('新的还在', c.get('d').hit === true)

  /* TTL */
  const short = createCache({ name: 'ttl', defaultTtl: 1 })
  short.put('x', 1)
  await new Promise((r) => setTimeout(r, 25))
  /* 只取一次 —— 取过之后缓存已经删了，再取会变成 miss */
  const expiredOnce = short.get('x')
  check('★ 过 TTL 失效', expiredOnce.hit === false)
  check('原因是 expired', expiredOnce.reason === 'expired')

  /* 自定义失效判据 */
  let ok = true
  const custom = createCache({
    name: 'custom',
    validate: () => (ok ? true : 'changed'),
  })
  custom.put('k', 'v')
  check('判据说有效就命中', custom.get('k').hit === true)
  ok = false
  const invalid = custom.get('k')
  check('★ 判据说无效就失效', invalid.hit === false)
  check('★ 而且把判据给的原因带出来', invalid.reason === 'changed')

  /*
   * 批量作废（`invalidateWhere`）在 0.76.0 **删掉了** ——
   * 当初是「给将来留的口子」，但复查时发现**它真的没有用处**：
   * 写文件后要作废的只有那个文件（已经显式 invalidate），而目录树缓存
   * AG-020 有意没做。死代码还会给人「这东西在用」的错觉。
   * 所以这里不测它了 —— 将来真需要时再加三行就够。
   */

  /* ── 字节预算（0.76.0 加的闸） ── */
  const tiny = createCache({ name: 'bytes', max: 100, maxBytes: 200 })
  tiny.put('a', 'x'.repeat(50)) // UTF-16 下算 100 字节
  check('字节预算内能存下', tiny.get('a').hit === true)
  tiny.put('b', 'y'.repeat(50))
  tiny.put('c', 'z'.repeat(50))
  check('★ 超出字节预算会淘汰最老的（哪怕条数还没满）', tiny.get('a').hit === false)
  check('新加的还在', tiny.get('c').hit === true)
  check('★ stats 报的是真实占用', tiny.stats().bytes <= 200)

  const capped = createCache({ name: 'cap', maxEntryBytes: 100 })
  const rejected = capped.put('big', 'x'.repeat(200))
  check('★ 单条超过上限就不缓存', rejected === null)
  check('也没留在库里', capped.get('big').hit === false)
  check('★ stats 里记下了「因过大跳过」', capped.stats().skipped === 1)

  const fresh = createCache({ name: 'fresh' })
  fresh.put('k', 'v1')
  fresh.put('k', 'v2')
  check('覆盖同一条不会让字节虚高', fresh.stats().bytes === fresh.get('k').value.length * 2)
  check('拿到的是新值', fresh.get('k').value === 'v2')

  /* ── 搜索缓存 ── */
  searchCache.clear()
  const results = [{ title: 'a', url: 'https://example.com/a' }]
  searchCache.put('duckduckgo', '胡斯战争', 5, results)
  const hit = searchCache.get('duckduckgo', '胡斯战争', 5)
  check('★ 同样的查询命中缓存', hit.hit === true)
  check('拿到的是同一批结果', hit.value?.[0]?.url === 'https://example.com/a')

  check('不同 provider 不串', searchCache.get('tavily', '胡斯战争', 5).hit === false)
  check('不同的结果条数不串', searchCache.get('duckduckgo', '胡斯战争', 3).hit === false)

  /* 归一化：大小写和多余空格不算区别（但**不改词序、不去标点**） */
  check(
    '★ 大小写/空白归一化（「Hussite  War」和「hussite war」同一个键）',
    searchCache.normalize('Hussite  War') === 'hussite war',
  )
  check(
    '★ 但不去标点（那是另一个查询）',
    searchCache.normalize('胡斯战争，1419') !== searchCache.normalize('胡斯战争 1419'),
  )
  searchCache.put('duckduckgo', 'Jan Hus', 5, results)
  check('归一化后能命中', searchCache.get('duckduckgo', '  jan   hus  ', 5).hit === true)

  /* ── 搜索：fresh 与时效标注（0.76.0） ── */
  const { formatResults } = require(join(ROOT, 'electron/core/search.cjs'))
  const sample = [{ title: 'T', url: 'https://e.com', snippet: 's' }]

  const plain = formatResults('q', sample)
  check('没有 meta 时不加时效话（普通结果不该多出一行）', !plain.includes('直接复用了缓存'))

  const cachedText = formatResults('q', sample, { cached: true, ageMs: 3 * 60 * 1000 })
  check('★ 命中缓存时告诉模型「多久前的」', cachedText.includes('3 分钟前'))
  check('★ 而且说清楚怎么绕过缓存', cachedText.includes('fresh=true'))
  check('★ 也点明了什么时候该绕过（时效敏感）', cachedText.includes('时效敏感'))

  const justNow = formatResults('q', sample, { cached: true, ageMs: 5 * 1000 })
  check('很短的时间用「秒」而不是「0 分钟」', justNow.includes('秒前'))

  const webSrc = readCore('electron/core/tools/search_web.cjs')
  check('★ search_web 暴露了 fresh 参数', webSrc.includes('fresh: {'))
  check('★ 而且真的传下去了', webSrc.includes('fresh: args.fresh === true'))
  check('fresh 的描述里给了「什么时候用」', webSrc.includes('时效敏感'))

  const coreSrc = readCore('electron/core/search.cjs')
  check('★ fresh 时跳过缓存查询', coreSrc.includes('if (!options.fresh)'))
  check(
    '★ 但 fresh 的结果照样写回缓存（下一次就不用了）',
    coreSrc.includes('searchCache.put(id, text, maxResults, out'),
  )
  check('fresh 会记在日志里（“怎么又联网了”有据可查）', coreSrc.includes('跳过缓存'))

  /* ── 缓存现状进了诊断包（不然那堆数字永远校准不了） ── */
  const diagSrc = readCore('electron/core/diagnostics.cjs')
  check('★ 诊断包里能看到缓存状态', diagSrc.includes("'## 缓存'"))
  check('★ 带命中率（校准 TTL 的唯一依据）', diagSrc.includes('命中率'))
  const searchSrc = readCore('electron/core/search.cjs')
  check('★ 搜索前先查缓存', searchSrc.includes('searchCache.get(id, text, maxResults)'))
  check(
    '★ 没命中才发网络请求，并把结果存起来',
    searchSrc.includes('searchCache.put(id, text, maxResults'),
  )
  check('命中时会记日志（便于诊断「怎么没去搜」）', searchSrc.includes('命中缓存'))
  check(
    '★ 过滤后的结果才进缓存（不对空 url 建缓存）',
    searchSrc.indexOf('filter((r) => r.url)') < searchSrc.indexOf('searchCache.put('),
  )

  /* ── 通用件确实被复用（不是复制了一份） ── */
  const fileCacheSrc = readCore('electron/core/file-cache.cjs')
  /* 注意：这里不能写出完整的 require 字面量 ——
     有个守卫会把它当成真的 require 去查文件是否存在 */
  check('file-cache 改成基于通用件', fileCacheSrc.includes("'./cache.cjs'"))
  check(
    '★ file-cache 里只剩文件自己的判据（mtime）',
    fileCacheSrc.includes('entry.fileModifiedTime'),
  )
  check(
    'search-cache 也基于通用件',
    readCore('electron/core/search-cache.cjs').includes("'./cache.cjs'"),
  )

  /* ── 有意不做的那些，得留下说明 ── */
  check(
    '★ AG-020 的取舍写进了注释放（不是忘了做）',
    readCore('scripts/selftest/groups/29-contextcache.mjs').includes('有意不做'),
  )
}
