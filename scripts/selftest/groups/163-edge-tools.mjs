/**
 * 自检 / 本批：**Edge 能力接成工具** + M04 补齐（clear / focus / key）+ M05 补齐（新建 / 关闭）
 *
 * 四块：
 *   ① **工具确实存在且形状对**（`registry.ALL` / `toApiSchema`）—— 这是「能被调用」的判据；
 *   ② **风险档**（用户拍板「只在敏感动作确认」）：写类进 `MUTATING_TOOLS`（只分析轮拦住）、
 *      **不进** `WRITE_TOOLS`（不弹风险框）；只读类两个集合都不进；
 *   ③ **接线**：`handlers/ext.cjs` 的单例 + 工具从它取（不能自己 new）；
 *   ④ **补齐动作**：注入函数自包含、渲染转发、tabs 两道闸。
 */

import { readFileSync, join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const R = (p) => readFileSync(join(ROOT, p), 'utf8')

/** 9 个工具名（写类 7 + 只读类 2） */
const WRITE_EDGE = [
  'edge_page',
  'edge_click',
  'edge_type',
  'edge_select',
  'edge_scroll',
  'edge_key',
  'edge_focus',
  'edge_tabs',
]
const READ_EDGE = ['edge_wait']

export async function run() {
  const registry = require(join(ROOT, 'electron/core/tools/registry.cjs'))

  /* ── ① 工具存在 + schema 形状 ── */
  group('本批 · edge_* 工具确实注册了（「能被调用」的判据）')
  const names = registry.ALL.map((t) => t.name)
  for (const n of [...WRITE_EDGE, ...READ_EDGE]) {
    check(`★ 工具表里有 ${n}`, names.includes(n))
  }
  const schema = registry.toApiSchema()
  const byName = new Map(schema.map((s) => [s.function?.name, s.function]))
  check('★ 每个 edge 工具都有合法的 function schema', [...WRITE_EDGE, ...READ_EDGE].every((n) => byName.has(n)))
  check('★ edge_click / edge_type 必填 ref（参数校验兜底）', byName.get('edge_click')?.parameters?.required?.includes('ref') === true && byName.get('edge_type')?.parameters?.required?.includes('ref') === true)
  check('★ edge_tabs 的 action 有枚举（写错值会被 schema 拦）', Array.isArray(byName.get('edge_tabs')?.parameters?.properties?.action?.enum))
  check('★ 工具描述里点明「用户自己的 Edge」（与 browse_* 区分，模型不会选错）', [...WRITE_EDGE, ...READ_EDGE].every((n) => /用户(自己的|正在用的)\s*Edge/.test(String(byName.get(n)?.description ?? ''))))
  check('★★ browser.* 那一族没有被改名（改 browse 语义会静默破坏现有工具）', names.includes('browse') && names.includes('browse_click') && names.includes('browse_type'))

  /* ── ② 风险档（用户拍板：只在敏感动作确认）── */
  group('本批 · 风险档（不弹风险框；但「只分析」那轮必须拦）')
  for (const n of WRITE_EDGE) {
    check(`★ ${n} 在 MUTATING_TOOLS（「只分析，不修改」轮会被拦）`, registry.MUTATING_TOOLS.has(n))
  }
  for (const n of WRITE_EDGE) {
    check(`★ ${n} **不在** WRITE_TOOLS（「需要确认」档不弹风险框 —— 用户拍板）`, registry.WRITE_TOOLS.has(n) === false)
  }
  for (const n of READ_EDGE) {
    check(`★ ${n} 两个集合都不进（纯读）`, !registry.MUTATING_TOOLS.has(n) && !registry.WRITE_TOOLS.has(n))
  }
  check('★ 敏感确认卡仍在（写类不弹框 ≠ 取消确认卡）', /gate\.judge/.test(R('electron/core/ext-command.cjs')))

  /* ── ③ 接线：单例 + 工具从中取 ── */
  group('本批 · 接线（工具拿到的是**同一个**指令实例）')
  const extHandlerSrc = R('electron/handlers/ext.cjs')
  const sharedSrc = R('electron/core/tools/edge-shared.cjs')
  const regHandlersSrc = R('electron/register-handlers.cjs')
  check('★ handlers/ext.cjs 有 setCommand / getCommand', /function setCommand\(/.test(extHandlerSrc) && /function getCommand\(/.test(extHandlerSrc))
  check('★ 装配处调了 setCommand（漏了 = 工具取到 null）', /extHandler\.setCommand\(extCommand\)/.test(regHandlersSrc))
  check('★★ 工具从 handlers/ext.cjs 取（不自己 new —— 自己 new 的话回执配不上）', /require\('\.\.\/\.\.\/handlers\/ext\.cjs'\)/.test(sharedSrc) && /getCommand\(\)/.test(sharedSrc))
  check('★★ 工具**不直接** require ext-command 建实例', !/createCommand\(/.test(sharedSrc))
  check('★ 没连上时给人话（不是干等或空成功）', /NO_EDGE/.test(sharedSrc) && /工具栏/.test(sharedSrc))
  check('★★ 工具用的文本来自落盘链的 markdown（不自己再格式化一份）', /res\.markdown/.test(sharedSrc))
  check(
    '★★ landAction 必须**透传** markdown（漏了工具只能回原始 JSON —— 真机逮到过）',
    /markdown: typeof saved\.markdown === 'string'/.test(R('electron/core/ext-command.cjs')),
  )
  check(
    '★★ error 可能是字符串（不能直接取 .message，否则渲染成「错误：undefined」）',
    /typeof res\.error === 'string' \? res\.error : res\.error\.message/.test(sharedSrc),
  )
  check(
    '★★ navigating 与 no-result **同族**渲染（漏了会渲染成「执行失败」→ 模型会重试 → 点两次）',
    /r\.reason === 'no-result' \|\| r\.reason === 'navigating'/.test(R('electron/core/ext-observe.cjs')),
  )

  /* ── ④ M04 补齐：clear / focus / key ── */
  group('本批 · M04 补齐（clear / focus / key）')
  const editSrc = R('harbor-edge/extension/lib/act-edit.js')
  const actRunSrc = R('harbor-edge/extension/lib/act-run.js')
  const cmdRunSrc = R('harbor-edge/extension/lib/command-run.js')
  for (const fn of ['focusElement', 'pressKey']) {
    check(`★ ${fn} 是具名导出函数`, new RegExp(`export function ${fn}\\(`).test(editSrc))
  }
  check('★ act-edit.js 的函数体里没有 require / import', !/\brequire\(/.test(editSrc.replace(/^import[\s\S]*?\n\n/m, '')))
  check('★ act-edit.js 顶层没有常量会被泄漏进函数体', [...editSrc.matchAll(/^const ([A-Za-z_$][\w$]*)/gm)].length === 0)
  check('★★ 键盘事件三种都派（只派一种会「有的页面管用有的不管用」）', /keydown/.test(editSrc) && /keypress/.test(editSrc) && /keyup/.test(editSrc))
  check('★ 按键也带「怎么变」的证据（与 click 同口径）', /domChanged/.test(editSrc))
  check('★ 聚焦的证据是**可读名字**（不是 true/false）', /activeAfter/.test(editSrc))
  check('★★ clear **复用 type**（不另写注入函数 —— 少一处会漂的实现）', /command === 'clear'/.test(actRunSrc) && /typeText, \[String\(a\.ref/.test(actRunSrc))
  check('★ act-run 分发了 focus / key', /command === 'focus'/.test(actRunSrc) && /command === 'key'/.test(actRunSrc))
  check('★ ext-actions 有 clear / focus / key', ['clear', 'focus', 'key'].every((m) => new RegExp(`async function ${m}\\(`).test(R('electron/core/ext-actions.cjs'))))
  check('★ ext-command 转发了三个新动作', /clear: \(payload\)/.test(R('electron/core/ext-command.cjs')) && /focus: \(payload\)/.test(R('electron/core/ext-command.cjs')) && /key: \(payload\)/.test(R('electron/core/ext-command.cjs')))
  check('★ 渲染按 kind 转发（ext-observe 不再长大）', /kind === 'clear'/.test(R('electron/core/ext-observe.cjs')) && /kind === 'focus'/.test(R('electron/core/ext-observe.cjs')) && /kind === 'key'/.test(R('electron/core/ext-observe.cjs')))
  check('★★ 渲染拆到 ext-act-render.cjs，并由 ext-actions **再导出**（调用点不用改）', /require\('\.\/ext-act-render\.cjs'\)/.test(R('electron/core/ext-actions.cjs')) && /renderEvidence: R\.renderEvidence/.test(R('electron/core/ext-actions.cjs')))
  check('★ 渲染仍只有一处实现（ext-act-render 是唯一定义点）', /function renderEvidence/.test(R('electron/core/ext-act-render.cjs')) && !/function renderEvidence/.test(R('electron/core/ext-actions.cjs')))

  /* ── ⑤ M05 补齐：新建 / 关闭 ── */
  group('本批 · M05 补齐（新建 / 关闭标签页）')
  const tabsRunSrc = R('harbor-edge/extension/lib/tabs-run.js')
  const tabsMainSrc2 = R('electron/core/ext-tabs.cjs')
  check('★ 扩展侧有 createTab / closeTab', /export async function createTab\(/.test(tabsRunSrc) && /export async function closeTab\(/.test(tabsRunSrc))
  check('★★ close 也要求 id 在 list 里出现过（防编 id 关掉看不见的标签）', /export async function closeTab[\s\S]*?listTabs\(\)[\s\S]*?not-in-list/.test(tabsRunSrc))
  check('★★ close 是**回读确认**（不是「remove 没抛错」就算成功）', /stillInList/.test(tabsRunSrc) && /chrome\.tabs\.remove/.test(tabsRunSrc))
  check('★ create 也回读（拿 id / 标题 / 地址）', /chrome\.tabs\.create/.test(tabsRunSrc) && /created: \{ id/.test(tabsRunSrc))
  check('★ SW 分发认 tabs-create / tabs-close', /tabs-create/.test(cmdRunSrc) && /tabs-close/.test(cmdRunSrc))
  check('★ 主进程有 tabsCreate / tabsClose', /async function create\(/.test(tabsMainSrc2) && /async function close\(/.test(tabsMainSrc2))
  check('★ 关闭没给 id → 明确拒绝（不瞎关）', /没给要关闭的标签 id/.test(tabsMainSrc2))
  check('★ 渲染标出「回读确认」（不是调用了就算成功）', /回读确认/.test(tabsMainSrc2))
  check('★ 主进程导出了五个 tabs 方法', ['tabsList', 'tabsSearch', 'tabsActivate', 'tabsCreate', 'tabsClose'].every((m) => new RegExp(`${m}: `).test(R('electron/core/ext-command.cjs'))))

  /* ── ⑥ 只读档 / 联网门覆盖 ── */
  group('本批 · 执行门的覆盖（只读档 + 本轮禁网）')
  const idxSrc = R('electron/core/tools/index.cjs')
  check('★★ 只读档也拦 edge（原来只按 WRITE_TOOLS 判 —— 写类不进那个集合就漏了）', /readonly' && \(isWrite \|\| MUTATING_TOOLS\.has\(name\)\)/.test(idxSrc))
  check('★ 本轮禁网覆盖 edge（它会真的访问网页）', /name\.startsWith\('edge_'\)/.test(idxSrc))
}
