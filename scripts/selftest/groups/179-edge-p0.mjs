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
}
