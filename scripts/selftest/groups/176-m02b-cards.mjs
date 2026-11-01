/**
 * 自检 / M02-B：**当前网页卡 + 上下文开关 + 任务卡**
 *
 * ── 这一组钉什么 ───────────────────────────────────────────────
 *
 *   ① **任务卡的状态推导**（纯函数）：相位 / 工具 / 待确认 / 收尾。
 *      必须真跑 —— 它的输入是渲染层真实事件形状，靠读源码钉不住。
 *   ② **当前网页卡的「能不能读」判据**（纯函数）：`canRead` 是唯一口径。
 *      它判错的后果是「对读不了的页面显示能读」，用户点下去才发现失败。
 *   ③ **上下文开关**：默认开、存 `chrome.storage.local`（**不进 Harbor**）。
 *   ④ **接线**：ChatPanel 真的渲染了两张卡、数据真的来自扩展自己。
 *
 * ⚠️ 事件名必须是**渲染层真实发出的那些**。2026-10-20 查出一个静默失效：
 *    `PUSH_TYPES` 原来写 `tool_start`/`tool_end`，而渲染层发的是
 *    `agent.tool.started`/`agent.tool.completed` —— 永远命中不了且不报错。
 *    这里正面钉一遍（`175` 那边钉的是 `PUSH_TYPES` 源码，两边互补）。
 */

import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const R = (p) => readFileSync(join(ROOT, p), 'utf8')
const SRC = 'harbor-edge/src/sidepanel'

/* Node 24 能直接 import .ts（纯函数文件，没有 JSX）—— 与 require 混用没关系 */
async function importTs(name) {
  return import(`file:///${join(ROOT, SRC, name).replace(/\\/g, '/')}`)
}

export async function run() {
  const T = await importTs('task-state.ts')
  const P = await importTs('page-info.ts')

  /* ══════════════════════════════════════════════════════════════
     ① 任务卡：状态推导
     ══════════════════════════════════════════════════════════════ */
  group('M02-B 任务卡 · 从真实 chat:event 推导状态')

  const empty = T.emptyTask()
  check('★★ 初始不显示（没在跑）', T.shouldShowTask(empty) === false)

  const started = T.nextTaskState(empty, { type: 'turn_start', turn: 2 })
  check('★★★ turn_start → 开始显示，且记下第几轮', T.shouldShowTask(started) === true && started.turn === 2)

  const planned = T.nextTaskState(started, { type: 'plan', plan: ['a', 'b', 'c'] })
  check('★★ plan → 记下计划条目数', planned.planSteps === 3)

  /* ★ 渲染层真实事件名（不是 tool_start） */
  const toolOn = T.nextTaskState(planned, { type: 'agent.tool.started', name: 'read_file' })
  check('★★★ agent.tool.started（渲染层真名）→ 当前工具显示出来', toolOn.tool === 'read_file', toolOn.tool)

  const toolOff = T.nextTaskState(toolOn, { type: 'agent.tool.completed' })
  check('★★ agent.tool.completed → 清掉工具（回到「正在回复…」）', toolOff.tool === '')

  const failed = T.nextTaskState(toolOn, { type: 'agent.tool.failed' })
  check('★★ agent.tool.failed → 也清掉工具（不能永远挂着那个名字）', failed.tool === '')

  const confirm = T.nextTaskState(toolOff, { type: 'confirm_request' })
  check('★★★ confirm_request → 标记「等你确认」（最需要显眼的状态）', confirm.awaitingConfirm === true)

  const afterDone = T.nextTaskState(confirm, { type: 'done' })
  check('★★★ done → 卡片收掉，且**确认态一起清**（否则永远挂着「等你确认」）', T.shouldShowTask(afterDone) === false && afterDone.awaitingConfirm === false)
  check('★★ aborted → 同样收掉', T.shouldShowTask(T.nextTaskState(started, { type: 'aborted' })) === false)
  check('★★ error → 同样收掉', T.shouldShowTask(T.nextTaskState(started, { type: 'error' })) === false)

  /* 认不出的事件要原样返回同一个对象（调用方可据此跳过 setState） */
  check('★ 认不出的事件原样返回（不制造无谓渲染）', T.nextTaskState(started, { type: 'content', text: 'x' }) === started)
  check('★ 没有 type 也原样返回（不抛）', T.nextTaskState(started, {}) === started)

  /* ══════════════════════════════════════════════════════════════
     ② 当前网页卡：能不能读的判据
     ══════════════════════════════════════════════════════════════ */
  group('M02-B 当前网页卡 · 「能不能读」的唯一判据')

  check('★★★ 有 url → 能读', P.canRead({ title: 't', url: 'https://example.com/' }) === true)
  check('★★★ url 为空 → 读不了（activeTab 没授予时就是空）', P.canRead({ title: 't', url: '' }) === false)
  check('★★ 只有空白 url 也算读不了', P.canRead({ title: 't', url: '   ' }) === false)
  check('★★ 没有页面（null）→ 读不了', P.canRead(null) === false)

  check('★★ 域名从 url 解析', P.hostLabel({ title: '', url: 'https://a.example.com/x' }) === 'a.example.com')
  check('★★ 读不了时给人话而不是空白', P.hostLabel({ title: '', url: '' }) === '读不到地址')
  check('★ 标题为空 → 退回域名', P.titleLabel({ title: '', url: 'https://x.test/' }) === 'x.test')
  check('★ 有标题就用标题', P.titleLabel({ title: '示例页', url: 'https://x.test/' }) === '示例页')
  check('★ 没有页面时也给人话', P.titleLabel(null) === '没有活动页面')

  /* 上下文开关：默认开，只有明确存了 false 才算关 */
  check('★★★ 没存过 → 开（装好即用）', P.ctxEnabledFrom({}) === true)
  check('★★★ 存了 false → 关（用户主动关的）', P.ctxEnabledFrom({ [P.CTX_KEY]: false }) === false)
  check('★★ 存了 true → 开', P.ctxEnabledFrom({ [P.CTX_KEY]: true }) === true)
  check('★ 读不出来（undefined）→ 仍按开（与默认同向）', P.ctxEnabledFrom(undefined) === true)

  /* ══════════════════════════════════════════════════════════════
     ③ 接线：真的画出来了、数据真的来自扩展自己
     ══════════════════════════════════════════════════════════════ */
  group('M02-B 接线 · 两张卡真的渲染了，数据源对')

  const chatSrc = R(`${SRC}/ChatPanel.tsx`)
  check('★★★ ChatPanel 渲染了任务卡', /<TaskCard\s+state=\{task\}/.test(chatSrc))
  check('★★★ ChatPanel 渲染了当前网页卡', /<PageCard\s/.test(chatSrc))
  check(
    '★★ 两张卡在消息流**上方**（顺序：网页卡 → 任务卡 → 消息区）',
    chatSrc.indexOf('<PageCard') < chatSrc.indexOf('<TaskCard') && chatSrc.indexOf('<TaskCard') < chatSrc.indexOf('aria-label="消息流"'),
  )
  check('★★ ChatPanel 不再自己订阅推送（搬到 useChatStream，防两份实现）', !/onMessage\.addListener/.test(chatSrc))
  check('★★★ ChatPanel 用 useChatStream 拿状态', /useChatStream\(sessionId\)/.test(chatSrc))

  const pageSrc = R(`${SRC}/PageCard.tsx`)
  check('★★★ 当前网页卡自己读标签（chrome.tabs.query，不经主进程）', /chrome\.tabs\.query\(/.test(pageSrc) && !/requestHost\(/.test(pageSrc))
  check('★★ 跟着标签切换刷新（onActivated / onUpdated）', /chrome\.tabs\.onActivated\.addListener/.test(pageSrc) && /chrome\.tabs\.onUpdated\.addListener/.test(pageSrc))
  check('★★ 上下文开关存 chrome.storage.local（**不进 Harbor**）', /chrome\.storage\.local\.set\(\{\s*\[CTX_KEY\]/.test(pageSrc))
  check('★★ 判据不在组件里重写（从 page-info 取）', /from '\.\/page-info'/.test(pageSrc) && !/function canRead/.test(pageSrc))

  const taskSrc = R(`${SRC}/TaskCard.tsx`)
  check('★★ 任务卡只负责画（状态从 task-state 取）', /from '\.\/task-state'/.test(taskSrc) && !/function nextTaskState/.test(taskSrc))
  check('★★ 卡片的可访问名字是验收锚点', /aria-label="任务卡"/.test(taskSrc) && /aria-label="当前网页卡"/.test(pageSrc))

  const hookSrc = R(`${SRC}/useChatStream.ts`)
  check(
    '★★★ 流式订阅只此一处（两条状态同一批事件）',
    /*
     * ① 只有一处 `onMessage.addListener`（订阅唯一）
     * ② 同一条事件里同时更新 turn 与 task —— 实现写法是
     *    `nextTaskState(current.task, payload)`（hook 里变量名是 current 不是 prev）
     */
    /onMessage\.addListener/.test(hookSrc) && /nextTaskState\(/.test(hookSrc) && /payload\)/.test(hookSrc),
  )
  /* 事件名的真相源在 task-state.ts（hook 只调函数）—— 钉它认的是渲染层真名 */
  const stateSrc = R(`${SRC}/task-state.ts`)
  check('★★★ 任务卡认的是渲染层真名（agent.tool.started / .completed / .failed）', /agent\.tool\.started/.test(stateSrc) && /agent\.tool\.completed/.test(stateSrc) && /agent\.tool\.failed/.test(stateSrc))
  check('★★ 保留「临时会话 id 要跟着学过来」那条（真机踩过）', /pending_/.test(hookSrc))

  /* ══════════════════════════════════════════════════════════════
     ④ 上下文开关**真的管用**（不是个摆设）
     ══════════════════════════════════════════════════════════════ */
  group('M02-B 上下文开关 · 关掉就真的不读，且两条链路同一道门')

  /* 键必须两侧同一份字符串 —— 一边改了一边没改 = 开关永远读不到（静默失效） */
  const gateSrc = R('harbor-edge/extension/lib/context-gate.js')
  const keyOf = (s) => (s.match(/CTX_KEY\s*=\s*'([^']+)'/) || [])[1]
  check(
    '★★★ 存储键在扩展侧与面板侧是同一份字符串',
    Boolean(keyOf(gateSrc)) && keyOf(gateSrc) === keyOf(R(`${SRC}/page-info.ts`)),
    `扩展=${keyOf(gateSrc)} · 面板=${keyOf(R(`${SRC}/page-info.ts`))}`,
  )

  const swSrc2 = R('harbor-edge/extension/service-worker.js')
  check('★★★ 读当前页在采集前问上下文开关', /contextAllowed\(\)[\s\S]{0,200}resolveActiveTab/.test(swSrc2))
  check('★★★ 观察页面在采集前问上下文开关', /contextAllowed\(\)[\s\S]{0,300}resolveActiveTab/.test(R('harbor-edge/extension/lib/observe-run.js')))
  check(
    '★★★ browser.getElements 也经过上下文门（结构信息同样可能含页面内容）',
    /const ctx = await contextAllowed\(\)/.test(R('harbor-edge/extension/lib/observe-run.js')),
  )
  check('★★ 关掉时给人话（告诉用户去哪打开），不是一句「失败」', /上下文已关闭[\s\S]{0,80}当前网页卡/.test(gateSrc))
  /*
   * ★ 2026-10-20 修正：这条原来要求「读不出 storage → allowed:true」。
   *   用户明确指出那是**放行**语义错误 —— 读不出来 = 核实不了用户是不是关掉了开关，
   *   这时放行等于「storage 一坏，开关就失效」。现在必须拒绝。
   *   仍要区分两件事：**没存过**（undefined）= 默认开（那是真的没配置）。
   */
  check(
    '★★ 读不出 storage 时**拒绝**（核实不了就不能当作开着）',
    /catch\s*\{[\s\S]{0,200}allowed:\s*false/.test(gateSrc),
  )
  check('★★ 「没存过」仍按开（那才是真的没配置）', /stored\[CTX_KEY\]\s*===\s*false/.test(gateSrc))
}
