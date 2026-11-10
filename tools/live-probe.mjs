/**
 * `e2e-process-live.mjs` 在真界面里执行的那几段表达式（拆出来的原因：红线 300 行）。
 *
 * ★ 2026-11-11 重写（验收 cf7b513 时发现）：
 *   这套探针原来是按旧过程区写的（`button[aria-label="查看过程"]` / `[data-process-open]` /
 *   `[data-run-status]` 混用），而 6e53798「对话流界面层」之后界面换成了原生 `details` +
 *   `data-flow-*` 体系。**旧探针在新界面上一条都读不到**（entries 恒 0），
 *   于是 e2e 会「照跑不误、全部报红」—— 这正是 AGENT.md 警告的「脚本静默失效」。
 *
 * 当前契约（`src/components/chat/message/`）：
 *   · 过程入口   `details.flow-process > summary.flow-disclosure-trigger`（`aria-expanded`）
 *   · 入口文案   summary 内 `span[role="status"]`（跑完 = 「执行过程」，见 useFlowPresentation）
 *   · 展开区     `details.flow-process > .flow-disclosure-content`
 *   · 工具组摘要 `.flow-tool-group > button` 上的 `[data-tool-status]`（running/completed/failed/unconfirmed）
 *   · 工具明细   `ToolRunRow` 上的 `[data-run-status]`（同上四值）+ `[data-run-error]` 错误文案
 *   · 答复区     `[data-flow-answer]`、未结算 `[data-flow-unconfirmed]`
 *   · 验收区     `[data-flow-acceptance]`、证据 `[data-evidence-state]`
 *   · 失败说明   `.flow-process-caution`（`role="status"`）
 */

/**
 * 新建对话 / 发送 / 停止 —— **转出** `shot/ui-selectors.mjs` 那一份。
 *
 * 以前这里是 `/^新建对话/` 前缀匹配，会点中侧栏的「新建对话并指定目录」
 * （弹原生目录框、挡住后面每一步）。`SEND` 也自己写了一份 `/发送消息/`，
 * 和停止那一组是同一个坑（包含匹配会撞上「立即发送（先停止当前任务）」）。
 * 挑选规则现在只有一处，本文件只做转发。
 */
export { NEW_CHAT, SEND, STOP, RUNNING } from './shot/ui-selectors.mjs'

/** 往输入框写一句话（走 React 的 value setter + input 事件，不然状态不更新） */
export const fillExpr = (text) =>
  `(function(){
    const ta = document.querySelector('textarea')
    if (!ta) return 0
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set
    set.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return ta.value.length
  })()`

/** 过程入口的通用取法（新 DOM：原生 details） */
const ENTRY_HELPERS = `
  const entriesOf = () => [...document.querySelectorAll('details.flow-process')]
  const lastEntry = () => entriesOf()[entriesOf().length - 1] || null
  const summaryOf = (d) => d ? d.querySelector(':scope > summary') : null
  const paneOf = (d) => d ? d.querySelector(':scope > .flow-disclosure-content') : null
  const entryTextOf = (d) => {
    const s = summaryOf(d)
    if (!s) return null
    const role = s.querySelector('[role="status"]')
    return ((role || s).textContent || '').trim()
  }
  /* 工具组默认收起（成功组），明细要展开组才能读到 —— 判据前先展开 */
  const openGroups = (pane) => {
    if (!pane) return 0
    let n = 0
    for (const b of pane.querySelectorAll('.flow-tool-group > button[aria-controls]')) {
      if (b.getAttribute('aria-expanded') === 'false') { b.click(); n += 1 }
    }
    return n
  }
`

/** 点一下过程入口（展开 / 收起）—— 有多条消息时点**最后一条**（最新那轮） */
export const TOGGLE = `(function(){
  ${ENTRY_HELPERS}
  const d = lastEntry()
  const s = summaryOf(d)
  if (!s) return false
  s.click()
  return true
})()`

/**
 * 采样：入口 / 流光 / 计算样式 / 布局，一次读全。
 *
 * ★ 读的是**计算样式**，不是类名 —— 类名对而样式被别处覆盖（比如
 *   `background-clip` 不支持、`-webkit-text-fill-color` 被主题覆盖）时，
 *   只查类名会照样报绿，屏幕上却什么都没有。
 */
export const PROBE = `(function(){
  ${ENTRY_HELPERS}
  const d = lastEntry()
  const s = summaryOf(d)
  const el = d ? d.querySelector('.flow-running-label') : null
  const cs = el ? getComputedStyle(el) : null
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const answer = document.querySelector('[data-flow-answer]')
  return {
    entries: entriesOf().length,
    liveCount: document.querySelectorAll('.flow-running-label').length,
    liveText: el ? el.textContent : null,
    entryText: entryTextOf(d),
    width: s ? Math.round(s.getBoundingClientRect().width * 10) / 10 : null,
    animationName: cs ? cs.animationName : null,
    duration: cs ? cs.animationDuration : null,
    clip: cs ? (cs.backgroundClip || cs.webkitBackgroundClip) : null,
    fill: cs ? cs.webkitTextFillColor : null,
    bgImage: cs ? cs.backgroundImage : null,
    bgPos: cs ? cs.backgroundPosition : null,
    textShadow: cs ? cs.textShadow : null,
    expanded: Boolean(d && d.open),
    hasActivity: !!document.querySelector('[data-flow-process]'),
    bodyText: ((answer && answer.textContent) || '').trim().slice(0, 40),
    /* 入口的屏幕坐标：截图只能靠它裁出「那几个字」并放大，否则全屏图里 4 个字看不清 */
    entryRect: (() => {
      const r = s ? s.getBoundingClientRect() : null
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
    })(),
    reduce,
  }
})()`

/**
 * 点侧边栏里**另一条**对话（除当前这条之外的第一条 = 最近的一条历史）。
 *
 * ★ 为什么不用标题匹配：标题由模型（假上游）生成，几条会话可能同名；
 *   而用户那句原话也出现在消息气泡里，全局按文本搜会点错地方（踩过两次）。
 *   用 `aria-current` 认「当前是哪条」，再取它的邻居 —— 不依赖任何文案。
 *
 * ★ 2026-11-11 修（验收 cf7b513）：外层容器**已经没有** `[aria-label="侧边栏"]` 了。
 *   现在侧栏分成两个区：`aria-label="对话文件夹"` 与 `aria-label="单独对话"`。
 *   旧的定位方式一处都找不到 → 返回 false → 「切回历史对话」永远失败。
 *
 * ★★ 第二个坑（同一轮踩到）：只看 `role="button"` 会把**行内的操作按钮**（重命名 / 归档 /
 *   删除 / 更多）也算成一行，点中它们只会弹菜单，主区域仍是空白页。
 *   真正的会话行是 `ThreadRow` 那个 `div[role="button"]`，它带 `aria-current` 属性
 *   （`aria-current={active}` —— 非选中时是 `false`，**仍然是这个属性存在**）。
 *   所以判据用「**有 aria-current 属性**」，而不是「值等于 true」。
 */
export const clickNeighbour = `(function(){
  const zones = [
    ...document.querySelectorAll('[aria-label="单独对话"], [aria-label="对话文件夹"], [aria-label="已归档的对话"]'),
  ]
  if (zones.length === 0) return false
  /* 会话行 = 带 aria-current 属性的 [role=button]（行内小按钮没有这个属性） */
  const rows = zones.flatMap((z) =>
    [...z.querySelectorAll('[role="button"][aria-current]')].filter((r) => (r.textContent || '').trim()),
  )
  if (rows.length === 0) return false
  /*
   * ★★ 第三个坑（2026-11-11 同一轮踩到）：刚新建的空对话里侧栏**没有任何一条**
   *   aria-current="true"。旧写法先找 cur（找不到 → undefined），再 rows.find(r => r !== cur)
   *   —— cur 是 undefined 时那条命中的永远是**第一条**，于是「切到下一条」原地打转。
   *   正确语义：把「上次点过的那条」记在 window 上，每次跳**下一条**（环形），
   *   这样调用方可以逐条试过去，直到找到有过程记录的那条为止。
   */
  const lastIdx = Number(window.__harborNeighbourIdx ?? -1)
  const curIdx = rows.findIndex((r) => r.getAttribute('aria-current') === 'true')
  /*
   * ★ 刷新后 window 上的下标会归零（整页重载），必须能从「当前选中项」重新起步；
   *   而新建空对话时又没有选中项（curIdx = -1）→ 从第一条开始逐个试。
   */
  const start = lastIdx >= 0 ? lastIdx : curIdx
  const nextIdx = (start + 1) % rows.length
  window.__harborNeighbourIdx = nextIdx
  rows[nextIdx].click()
  return { ok: true, index: nextIdx, total: rows.length, text: (rows[nextIdx].textContent || '').trim().slice(0, 40) }
})()`

/** 把根元素的动效开关设成 on/off（验证「设置里关掉动效」那条路径） */
export const setAnimations = (on) => `(function(){
  const root = document.documentElement
  if (${on}) root.removeAttribute('data-animations')
  else root.setAttribute('data-animations', 'off')
  return root.getAttribute('data-animations')
})()`

/**
 * 采样：过程区**状态口径**（图2 验收表用的那一组）。
 *
 * 读的都是界面自己标出来的事实（`data-*`），不猜文案、不数像素。
 * ★ 两层状态要分开读（2026-11-11）：
 *   · `groupStatuses` —— 工具**组摘要**行（`[data-tool-status]`），一个组一个值
 *   · `lineStatus`    —— **每条工具明细**（`[data-run-status]`），一条一个值
 *   图2 要的「顺序是失败在前成功在后」看的是明细那一层。
 */
export const PROBE_PROCESS = `(function(){
  ${ENTRY_HELPERS}
  const entries = entriesOf()
  const d = entries[entries.length - 1] || null
  const pane = paneOf(d)
  openGroups(pane)
  const groups = pane ? [...pane.querySelectorAll('[data-tool-status]')] : []
  const rows = pane ? [...pane.querySelectorAll('[data-run-status]')] : []
  const caution = d ? d.parentElement?.querySelector('.flow-process-caution') : null
  const stateOf = (n) => n.getAttribute('data-tool-status') || n.getAttribute('data-run-status')
  const answer = document.querySelector('[data-flow-answer]')
  const acceptance = document.querySelector('[data-flow-acceptance]')
  return {
    entries: entries.length,
    entryText: entryTextOf(d),
    /* 「是否有失败」由界面自己那句话决定（新 DOM 没有 data-process-failed 这个标记） */
    failedMark: Boolean(caution && (caution.textContent || '').includes('失败')),
    cautionText: caution ? (caution.textContent || '').trim().slice(0, 120) : null,
    open: Boolean(d && d.open),
    /*
     * 状态读**属性值**（running / completed / failed / unconfirmed），不读文案 ——
     * 文案会随措辞改，属性是内核契约。
     */
    groupStatuses: groups.map(stateOf),
    groupTexts: groups.map((n) => (n.textContent || '').trim()),
    statuses: rows.map(stateOf),
    statusTexts: rows.map((n) => (n.textContent || '').trim()),
    lineStatus: rows.map(stateOf),
    lineTexts: rows.map((n) => (n.textContent || '').trim()),
    errors: pane ? [...pane.querySelectorAll('[data-run-error]')].map((n) => (n.textContent || '').trim().slice(0, 120)) : [],
    /* 主区域里是不是还铺着大段原文（有 <pre> 就是没被收进次级区域） */
    rawPre: !!(pane && pane.querySelector('pre')),
    /* 展开区原文（调试 / 判据都能用：出问题时能直接看到界面到底写了什么） */
    paneText: pane ? (pane.innerText || '').replace(/\\s+/g, ' ').slice(0, 600) : null,
    bodies: document.querySelectorAll('[data-flow-answer]').length,
    answerText: answer ? (answer.textContent || '').trim().slice(0, 200) : null,
    unconfirmed: Boolean(document.querySelector('[data-flow-unconfirmed]')),
    acceptance: Boolean(acceptance),
    acceptanceText: acceptance ? (acceptance.textContent || '').trim().slice(0, 120) : null,
    evidenceStates: [...document.querySelectorAll('[data-evidence-state]')].map((n) =>
      n.getAttribute('data-evidence-state'),
    ),
  }
})()`

/**
 * 确保过程区是**展开**的（已经展开就不动）。
 *
 * ★ 为什么不直接 `TOGGLE`：失败 / 中断时过程**默认就是展开的**，
 *   再点一次反而把它收起来 —— 那样判据读到的是「没展开」，还以为是界面坏了。
 */
export const ENSURE_OPEN = `(function(){
  ${ENTRY_HELPERS}
  const d = lastEntry()
  if (d && d.open) return 'already'
  const s = summaryOf(d)
  if (!s) return 'no-entry'
  s.click()
  return 'clicked'
})()`

/** 读状态词的计算颜色（替代「人工看截图」：颜色对不对由样式证据说话） */
export const PROBE_COLORS = `(function(){
  ${ENTRY_HELPERS}
  const d = lastEntry()
  const pane = paneOf(d)
  if (!pane) return { rows: [] }
  openGroups(pane)
  const read = (n) => ({
    state: n.getAttribute('data-run-status') || n.getAttribute('data-tool-status'),
    text: (n.textContent || '').trim(),
    color: getComputedStyle(n).color,
  })
  const rows = [...pane.querySelectorAll('[data-run-status], [data-tool-status]')].map(read)
  return { rows }
})()`

/** 点展开区里那句「查看完整输出」（次级区域） */
export const SHOW_RAW = `(function(){
  const b = [...document.querySelectorAll('button')].find((x) =>
    /查看完整输出/.test((x.textContent || '').trim()),
  )
  if (!b) return false
  b.click()
  return true
})()`
