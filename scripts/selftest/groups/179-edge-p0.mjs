/** Edge 侧边栏 P0：来源、会话归属与隐私门的真实形状。 */
import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const source = (path) => readFileSync(join(ROOT, path), 'utf8')
const extImport = (path) => import(`file:///${join(ROOT, path).replace(/\\/g, '/')}`)

export async function run() {
  group('Edge P0 · 来源与会话归属')
  const note = require(join(ROOT, 'electron/core/tools/_web-note.cjs'))
  check('Edge 内容标 Edge 来源', note.wrapWebText({ source: 'edge', url: 'https://a.test', text: '正文' }).includes('用户 Edge 当前标签'))
  check('内置浏览器内容标内置来源', note.wrapWebText({ url: 'https://a.test', text: '正文' }).includes('Harbor 内置浏览器'))
  const router = (await extImport('harbor-edge/extension/lib/messages.js')).createPanelRouter({
    observePage: async (message) => ({ ok: true, sessionId: message.sessionId }),
  })
  const routed = await new Promise((resolve) => router({ type: 'observe-page', sessionId: 'sess_A' }, null, resolve))
  check('观察页面把原会话 ID 交给执行器', routed.sessionId === 'sess_A')

  const extension = require(join(ROOT, 'electron/handlers/ext.cjs'))
  extension.setCommand({ readCurrent: async () => ({ ok: true, url: 'https://edge.test', title: 'Edge', text: '真实正文' }) })
  const edgeRead = require(join(ROOT, 'electron/core/tools/edge-read.cjs'))
  const read = await edgeRead.run()
  check('edge_read 只从 Edge 指令取正文和网址', read.includes('https://edge.test') && read.includes('真实正文') && read.includes('用户 Edge 当前标签'))
  extension.setCommand(null)

  group('Edge P0 · 隐私与页面一致性')
  const gate = await extImport('harbor-edge/extension/lib/context-gate.js')
  const oldChrome = globalThis.chrome
  globalThis.chrome = { storage: { local: { get: async () => { throw new Error('storage failed') } } } }
  const blocked = await gate.contextAllowed()
  globalThis.chrome = oldChrome
  check('存储故障时不采集页面', blocked.allowed === false)
  const pageText = await extImport('harbor-edge/extension/lib/page-text.js')
  const limited = pageText.limitPageText({ url: 'https://edge.test', title: 'Edge', text: 'abcdef' }, 3)
  check('采集正文截断时保留实际网址并标记', limited.url === 'https://edge.test' && limited.text === 'abc' && limited.truncated === true)
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<main><h1>标题</h1><p>正文</p><table><tr><th>项目</th><td>结果</td></tr></table><img alt="示意图"></main><nav>导航噪声</nav>', { url: 'https://edge.test/article' })
  const beforeDocument = globalThis.document
  const beforeLocation = globalThis.location
  const beforeObserver = globalThis.MutationObserver
  globalThis.document = dom.window.document
  globalThis.location = dom.window.location
  globalThis.MutationObserver = dom.window.MutationObserver
  const article = pageText.collectPageText()
  check('阅读模式保留标题、表格和图片说明', article.text.includes('# 标题') && article.text.includes('| 项目 | 结果 |') && article.text.includes('[图片说明] 示意图') && !article.text.includes('导航噪声'))
  const settling = pageText.waitForStablePage()
  setTimeout(() => { dom.window.document.querySelector('p').textContent = '异步正文' }, 80)
  const stable = await settling
  check('SPA 内容变动后等待安静再读取', stable.stable === true && pageText.collectPageText().text.includes('异步正文'))
  globalThis.document = beforeDocument
  globalThis.location = beforeLocation
  globalThis.MutationObserver = beforeObserver
  dom.window.close()
  check('采集后核对实际 URL 与活动标签', source('harbor-edge/extension/service-worker.js').includes('stillActiveTab(tab.id, url)') && source('harbor-edge/extension/lib/observe-run.js').includes('stillActiveTab(tab.id, target.url)'))
  check('侧边栏浏览器来源运行时阻止悄悄改用 browse', source('electron/core/tools/index.cjs').includes("ctx.origin === 'edge-sidepanel' && name.startsWith('browse')"))

  group('Edge P0 · 选区快捷入口只填所属会话草稿')
  const quick = await extImport('harbor-edge/extension/lib/quick-entry.js')
  const stored = {}
  globalThis.chrome = { storage: { local: {
    get: async () => ({ harborSelected: { sessionId: 'sess_A' } }),
    set: async (value) => Object.assign(stored, value),
  } } }
  const draft = await quick.saveSelectionDraft('选中文字', 'https://edge.test/current')
  check('选区内容只保存为待编辑草稿，不自动发送', draft.ok && stored.harborSelectionDraft.text === '选中文字' && stored.harborSelectionDraft.sessionId === 'sess_A' && stored.harborSelectionDraft.url === 'https://edge.test/current')
  check('空选区不创建草稿', (await quick.saveSelectionDraft('', 'https://edge.test')).ok === false)
  globalThis.chrome = oldChrome
  check('快捷入口只在用户调用时注入选区按钮', source('harbor-edge/extension/lib/quick-entry.js').includes('showSelectionToolbar(tab)') && !JSON.parse(source('harbor-edge/extension/manifest.json')).content_scripts)

  group('Edge 长页 · 正文分段与元素过滤（2026-11-03）')
  /* ① 正文分段：真跑 limitPageText —— 段号、下一段 offset、读完的标志三者要对得上 */
  const long = 'x'.repeat(250)
  const seg1 = pageText.limitPageText({ url: 'https://edge.test/long', title: 'Long', text: long }, 100, 0)
  const seg2 = pageText.limitPageText({ url: 'https://edge.test/long', title: 'Long', text: long }, 100, 100)
  const seg3 = pageText.limitPageText({ url: 'https://edge.test/long', title: 'Long', text: long }, 100, 200)
  check('★ 第 1 段：说自己第 1 / 3 段，并给下一段 offset=100', seg1.segment === 1 && seg1.segments === 3 && seg1.nextOffset === 100 && seg1.text.length === 100)
  check('★ 第 3 段读完：nextOffset 是 null（不是 undefined、不是 250）', seg3.nextOffset === null && seg3.truncated === false && seg3.text.length === 50)
  check('★ 每段取的是**不同**的内容（offset 真的生效，不是总从头来）', seg2.offset === 100 && seg2.text === long.slice(100, 200))
  check('★ 超出正文长度不报错，返回空段 + 没有下一段', pageText.limitPageText({ text: 'abc' }, 10, 999).nextOffset === null)
  /* ② wrapWebText 必须把「下一段从哪读」讲给模型 —— 否则模型以为读完了 */
  const wrappedMid = note.wrapWebText({ source: 'edge', url: 'https://edge.test', text: 'aaa', truncated: true, segments: 3, segment: 1, nextOffset: 100 })
  check('★ 分段时明确给出「下一段传 offset=」', wrappedMid.includes('第 1 / 3 段') && wrappedMid.includes('offset=100'))
  check('★ 不分段（内置浏览器那条路）不凭空多出分段字样', !note.wrapWebText({ text: 'aaa' }).includes('段'))
  /* ③ 元素过滤：只缩显示窗口，**不动 ref、不动版本号** —— 真跑主进程渲染器 */
  const O = require(join(ROOT, 'electron/core/ext-observe.cjs'))
  const mk = (i) => ({ ref: `v1.${i}`, role: 'button', tag: 'BUTTON', text: `按钮${i}`, masked: false })
  const all = Array.from({ length: 9 }, (_, i) => mk(i + 1))
  const filtered = O.renderElements(
    { url: 'https://edge.test', title: 'T', pageVersion: 'v1', elements: all, stats: { elements: 9, query: '按钮5', matchedRefs: ['v1.3', 'v1.4', 'v1.5', 'v1.6', 'v1.7'] } },
    {},
  )
  check('★ 过滤后只显示命中项 + 前后各 2 个', filtered.markdown.includes('v1.5') && filtered.markdown.includes('v1.3') && filtered.markdown.includes('v1.7'))
  check('★ 窗口外的元素不出现（不是「过滤只是加个标题」）', !filtered.markdown.includes('v1.2') && !filtered.markdown.includes('v1.8'))
  check('★ 过滤不改引用本身（还是 v1.5，没有被重编号成 v1.1）', filtered.markdown.includes('| v1.5 |') || filtered.markdown.includes('v1.5 |'))
  check('★ 说明里写清「整页 9 个 / 只显示 5 个」', filtered.markdown.includes('整页 9 个'))
  const noHit = O.renderElements({ url: 'u', title: 't', pageVersion: 'v1', elements: all, stats: { elements: 9, query: '不存在', matchedRefs: [] } }, {})
  check('★ 命中 0 个时不冒充「页面没有元素」，而是说没匹配', noHit.markdown.includes('没有一条匹配') && !noHit.markdown.includes('这个页面上没有可见的可交互元素'))
  /* ④ 扩展侧：过滤必须在版号/ref 之后（顺序反了 = 用户手里的 ref 全失效） */
  const obsSrcNow = source('harbor-edge/extension/lib/observe.js')
  const sigAt = obsSrcNow.indexOf('const version = fnv1a(')
  const filterAt = obsSrcNow.indexOf('matchedRefs = Array.from(keep)')
  check('★ 过滤在版本号之后算（顺序反了会凭空改版号、ref 全失效）', sigAt > 0 && filterAt > sigAt)
  check('★ 过滤窗口由扩展侧算，写进 stats（主进程只按它裁显示）', /stats:\s*\{[\s\S]*?\bquery,?[\s\S]*?\bmatchedRefs,?[\s\S]*?\}/.test(obsSrcNow) && source('electron/core/ext-observe.cjs').includes('stats.matchedRefs'))

  /*
   * ⑤ **真跑**采集器（JSDOM）：光读源码正则，抓不到「过滤把 ref 重排了」这种真错。
   *   jsdom 没有 checkVisibility、几何也全是 0 —— 打桩成可见，否则元素一个都进不来。
   */
  const observe = await extImport('harbor-edge/extension/lib/observe.js')
  const dom2 = new JSDOM(
    '<main><button>首页</button><button>文档</button><button>定价</button><a href="/login">登录</a>' +
      '<button>保存草稿</button><button>发布</button><input placeholder="搜索关键词"><button>退出</button><button>帮助</button></main>',
    { url: 'https://edge.test/page' },
  )
  dom2.window.Element.prototype.checkVisibility = function () { return true }
  const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location, gcs: globalThis.getComputedStyle }
  globalThis.window = dom2.window
  globalThis.document = dom2.window.document
  globalThis.location = dom2.window.location
  globalThis.getComputedStyle = dom2.window.getComputedStyle
  let plainObs
  let filteredObs
  try {
    plainObs = observe.collectPageContext({ maxItems: 60, maxSelection: 0 })
    filteredObs = observe.collectPageContext({ maxItems: 60, maxSelection: 0, query: '保存' })
  } finally {
    globalThis.window = saved.window
    globalThis.document = saved.document
    globalThis.location = saved.location
    globalThis.getComputedStyle = saved.gcs
    dom2.window.close()
  }
  const refsOf = (o) => JSON.stringify(o.elements.map((e) => e.ref))
  check('★ 真跑：不打 query 时 matchedRefs 是 null（不是空数组）', plainObs.stats.matchedRefs === null && plainObs.elements.length === 9)
  check('★★ 真跑：加 query 后**版本号一字不变**（过滤不该改版号）', plainObs.pageVersion === filteredObs.pageVersion)
  check('★★ 真跑：加 query 后**每个 ref 都和原来一样**（没有被重编号）', refsOf(plainObs) === refsOf(filteredObs))
  check('★ 真跑：窗口是命中项 + 前后各 2 个 = 5 个', filteredObs.stats.matchedRefs.length === 5)
  const winTexts = filteredObs.elements.filter((e) => filteredObs.stats.matchedRefs.includes(e.ref)).map((e) => e.text)
  check('★ 真跑：窗口里真的有命中的那个，且前后都带上', winTexts[2] === '保存草稿' && winTexts[0] === '定价' && winTexts[4] === '搜索关键词')
}
