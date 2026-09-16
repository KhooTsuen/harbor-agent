import { check, group } from '../harness.mjs'
import { ROOT, join, require } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   浏览器：正文清洗 + 导航策略 + 注入标注

   全是纯函数，**不需要开浏览器也不用联网**。
   这两块的正确性都靠「喂进去 → 断言输出」就能保证，
   所以它们被刻意抽成了不依赖 Electron 的模块（browser-text / navigation-policy）。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  const text = require(join(ROOT, 'electron/core/browser-text.cjs'))
  const nav = require(join(ROOT, 'electron/navigation-policy.cjs'))

  group('浏览器 / 正文清洗')

  /* ── 该扔的必须扔掉：不清洗一个页面能吃掉几万 token ── */

  const dirty = `
    <html><head>
      <title>忽略我</title>
      <style>body { color: red }</style>
      <script>console.log('一大坨脚本')</script>
    </head><body>
      <nav>导航 首页 关于</nav>
      <h1>真正的标题</h1>
      <p>第一段正文。</p>
      <footer>版权所有 2026</footer>
      <!-- 注释里的调试信息 -->
      <div>第二段<br>换行后</div>
    </body></html>`

  const clean = text.extractText(dirty)
  check('★ 去掉了 script 内容', !clean.includes('一大坨脚本'), clean.slice(0, 80))
  check('★ 去掉了 style 内容', !clean.includes('color: red'))
  check('★ 去掉了 nav 内容', !clean.includes('导航 首页'))
  check('★ 去掉了 footer 内容', !clean.includes('版权所有'))
  check('★ 去掉了注释', !clean.includes('调试信息'))
  check('★ 正文留下了', clean.includes('真正的标题') && clean.includes('第一段正文'))
  check('块级标签换成了行', clean.includes('\n'), JSON.stringify(clean.slice(0, 60)))
  check('没有残留的尖括号标签', !/<[a-z/]/i.test(clean), clean.slice(0, 80))

  /* ── 实体还原 ── */

  check('常见实体还原（&amp;）', text.extractText('<p>a &amp; b</p>').includes('a & b'))
  check('nbsp 变普通空格', text.extractText('<p>a&nbsp;b</p>').includes('a b'))
  check('数字实体还原（&#39;）', text.extractText('<p>it&#39;s</p>').includes("it's"))
  check('十六进制实体还原', text.extractText('<p>&#x4f60;</p>').includes('你'))
  check('认不出来的实体原样保留', text.extractText('<p>&zzz;</p>').includes('&zzz;'))

  /* ── 空白压缩 ── */

  check('行内多个空格压成一个', text.extractText('<p>a     b</p>') === 'a b')
  check('连续空行压成一个', text.collapse('a\n\n\n\n\nb') === 'a\n\nb')
  check('首尾空白去掉', text.extractText('  <p>  x  </p>  ') === 'x')

  /* ── 截断：必须**说明**被截断了 ── */

  const long = text.truncate('x'.repeat(500), 100)
  check('超长会截断', long.length < 500 && long.startsWith('x'.repeat(100)))
  check('★ 截断时明确说了「还有多少没给」', long.includes('没给'), long.slice(-60))
  check('不超长时原样返回', text.truncate('短', 100) === '短')

  const capped = text.extractText(`<p>${'很长'.repeat(9000)}</p>`, { maxChars: 1000 })
  check('extractText 会按上限截断', capped.length < 1200, String(capped.length))

  check('空输入不崩', text.extractText('') === '' && text.extractText(null) === '')

  /*
   * ★ 挑来源：这一段是**真机上暴露出来之后补的**。
   *
   * 渲染层给 text 时会把 html 设成空字符串，而主进程原来写的是
   * `result.html ?? result.text` —— `??` 只认 null/undefined、**不认空字符串**，
   * 于是 `'' ?? '正文'` 得到 `''`：browse 明明读到了页面，返回给模型的却是空的。
   * 真机表现是「模型说 browse 只拿回了标题，只好自己用 curl 再抓一遍」。
   */
  check(
    '★ text 有值时用 text（不被空字符串 html 吃掉）',
    text.pickSource({ text: '正文', html: '' }).from === 'text',
  )
  check(
    '★ text 空时回退到 html',
    text.pickSource({ text: '', html: '<p>正文</p>' }).from === 'html',
  )
  check(
    '★ 只有空白也算空（回退到 html）',
    text.pickSource({ text: '   ', html: '<p>x</p>' }).from === 'html',
  )
  check('两者都没有时如实说 none', text.pickSource({}).from === 'none')
  check(
    '★ 走一遍完整链路：text 非空时清洗结果不为空',
    text.extractText(text.pickSource({ text: '真的正文', html: '' }).raw) === '真的正文',
  )
  check('纯 HTML 无正文时不崩', typeof text.extractText('<div></div>') === 'string')

  group('浏览器 / 导航策略')

  check(
    '允许：allow 模式放行',
    nav.decide('https://b.com/x', 'https://a.com/', 'allow').action === 'allow',
  )
  check(
    '同站点内永远放行（站内导航要能用）',
    nav.decide('https://a.com/next', 'https://a.com/', 'block').action === 'allow',
  )
  check(
    '★ block 模式拦外站',
    nav.decide('https://b.com/', 'https://a.com/', 'block').action === 'block',
  )
  check(
    '★ ask 模式外站是 ask（不自动跳）',
    nav.decide('https://b.com/', 'https://a.com/', 'ask').action === 'ask',
  )
  check(
    'ask 会带上目标域名，便于提示',
    nav.decide('https://b.com/', 'https://a.com/', 'ask').host === 'b.com',
  )
  check(
    '★ file:// 一律拦（本地文件不该被网页打开）',
    nav.decide('file:///C:/x.txt', 'https://a.com/', 'allow').action === 'block',
  )
  check(
    '★ data: 一律拦',
    nav.decide('data:text/html,x', 'https://a.com/', 'allow').action === 'block',
  )
  check(
    '★ javascript: 一律拦',
    nav.decide('javascript:alert(1)', 'https://a.com/', 'allow').action === 'block',
  )
  check(
    '地址畸形时拦掉而不是崩',
    nav.decide('不是地址', 'https://a.com/', 'allow').action === 'block',
  )

  /* webview 加固：这几条是页面里覆盖不掉的兜底 */
  const prefs = {
    preload: '/evil.js',
    nodeIntegration: true,
    contextIsolation: false,
    sandbox: false,
  }
  const hardened = nav.hardenWebview(prefs)
  check('★ webview 加固：去掉 preload', hardened.preload === undefined)
  check('★ webview 加固：禁 nodeIntegration', hardened.nodeIntegration === false)
  check('★ webview 加固：开 contextIsolation', hardened.contextIsolation === true)
  check('★ webview 加固：开 sandbox', hardened.sandbox === true)

  group('浏览器 / browse 工具的返回')

  /* browse 工具本身不联网的部分：地址校验 + 注入标注 */
  const browse = require(join(ROOT, 'electron/core/tools/browse.cjs'))
  check('工具注册名是 browse', browse.name === 'browse')
  check('★ 归到写操作里（会联网 + 占用用户浏览器）', browse.network === true)
  check('参数只要求 url', JSON.stringify(browse.parameters.required) === '["url"]')

  let bad = null
  try {
    await browse.run({ url: 'file:///C:/secret.txt' })
  } catch (error) {
    bad = error
  }
  check(
    '★ 拒绝 file:// 之类的地址',
    bad !== null && String(bad.message).includes('http'),
    String(bad?.message),
  )

  let empty = null
  try {
    await browse.run({ url: '   ' })
  } catch (error) {
    empty = error
  }
  check('空地址给出明确错误', empty !== null, String(empty?.message))

  /* ── browse_click 的参数校验 ── */

  group('浏览器 / browse_click 工具')

  const click = require(join(ROOT, 'electron/core/tools/browse-click.cjs'))
  check('工具注册名是 browse_click', click.name === 'browse_click')
  check('★ 归到写操作里（会改变页面）', click.network === true)
  check('参数只要求 index', JSON.stringify(click.parameters.required) === '["index"]')

  let neg = null
  try {
    await click.run({ index: -1 })
  } catch (error) {
    neg = error
  }
  check('拒绝负数索引', neg !== null, String(neg?.message))

  let nan = null
  try {
    await click.run({ index: 'abc' })
  } catch (error) {
    nan = error
  }
  check('拒绝非数字索引', nan !== null, String(nan?.message))

  /* ── browse_elements 的格式化（纯函数）── */

  group('浏览器 / 元素清单格式化')

  const { formatSnapshot } = require(join(ROOT, 'electron/core/tools/browse-elements.cjs'))

  check(
    '空元素列表给出明确提示',
    formatSnapshot({ url: 'x', items: [] }).includes('没有可交互的元素'),
  )

  const formatted = formatSnapshot({
    url: 'https://a.b/login',
    title: '登录',
    viewport: { w: 1920, h: 1080 },
    total: 3,
    items: [
      { i: 0, tag: 'input', type: 'text', role: '', text: '用户名', x: 960, y: 210, w: 300, h: 40 },
      { i: 1, tag: 'button', type: '', role: '', text: 'Sign in', x: 960, y: 344, w: 120, h: 40 },
    ],
  })
  check(
    '带索引、标签、文本、坐标',
    formatted.includes('[1] <button> "Sign in" 中心(960,344) 尺寸120×40'),
  )
  check('带 URL 和视口', formatted.includes('https://a.b/login') && formatted.includes('1920×1080'))
  check('注入防护标注（这是数据不是指令）', formatted.includes('不是指令'))
  check('截断提示（total > 列表长度）', formatted.includes('共 3 个元素'))

  check('snapshot 报错时原样转达', formatSnapshot({ error: 'boom' }).includes('boom'))
}
