/**
 * `e2e-process-live.mjs` 在真界面里执行的那几段表达式（拆出来的原因：红线 300 行）。
 *
 * 为什么要单独一个文件而不是写在主脚本里拼字符串：`PROBE` 是这套验收的**判据本体**
 * ——「入口上挂了什么类、计算样式是什么、动画在不在动」。它被主流程多处采样，
 * 单独成一处定义，改了样子（比如把 `.process-live` 从 span 挪到 button）只需要改这里。
 */

/** 新建对话（按可访问文案找，不认 DOM 层级） */
export const NEW_CHAT = `(function(){
  const re = /^新建对话/
  const hit = (x) => re.test(x.getAttribute('aria-label') || '') || re.test(x.title || '') || re.test((x.textContent || '').trim())
  const b = [...document.querySelectorAll('button')].find(hit)
  if (!b) return false
  b.click()
  return true
})()`

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

/** 点发送 */
export const SEND = `(function(){
  const re = /发送消息/
  const hit = (x) => re.test(x.getAttribute('aria-label') || '') || re.test(x.title || '') || re.test((x.textContent || '').trim())
  const b = [...document.querySelectorAll('button')].find(hit)
  if (!b) return false
  b.click()
  return true
})()`

/** 点一下过程入口（展开 / 收起）—— 有多条消息时点**最后一条**（最新那轮） */
export const TOGGLE = `(function(){
  const all = [...document.querySelectorAll('button[aria-label="查看过程"]')]
  const b = all[all.length - 1]
  if (!b) return false
  b.click()
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
  const el = document.querySelector('.process-live')
  const entry = document.querySelector('button[aria-label="查看过程"]')
  const span = entry ? entry.querySelector('span') : null
  const cs = el ? getComputedStyle(el) : null
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  return {
    entries: document.querySelectorAll('button[aria-label="查看过程"]').length,
    liveCount: document.querySelectorAll('.process-live').length,
    liveText: el ? el.textContent : null,
    entryText: entry ? entry.textContent : null,
    width: span ? Math.round(span.getBoundingClientRect().width * 10) / 10 : null,
    animationName: cs ? cs.animationName : null,
    duration: cs ? cs.animationDuration : null,
    clip: cs ? (cs.backgroundClip || cs.webkitBackgroundClip) : null,
    fill: cs ? cs.webkitTextFillColor : null,
    bgImage: cs ? cs.backgroundImage : null,
    bgPos: cs ? cs.backgroundPosition : null,
    textShadow: cs ? cs.textShadow : null,
    expanded: !!document.querySelector('[data-process-open]'),
    hasActivity: !!document.querySelector('[data-process-activity]'),
    bodyText: (document.querySelector('[data-round-body]')?.textContent || '').slice(0, 40),
    /* 入口的屏幕坐标：截图只能靠它裁出「那几个字」并放大，否则全屏图里 4 个字看不清 */
    entryRect: (() => {
      const r = entry?.getBoundingClientRect()
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
    })(),
    reduce,
  }
})()`

/** 点停止（「停止生成」是 SendControls 里的按钮文案） */
export const STOP = `(function(){
  const b = document.querySelector('button[aria-label="停止生成"]')
  if (!b) return false
  b.click()
  return true
})()`

/**
 * 点侧边栏里**另一条**对话（除当前这条之外的第一条 = 最近的一条历史）。
 *
 * ★ 为什么不用标题匹配：标题由模型（假上游）生成，几条会话可能同名；
 *   而用户那句原话也出现在消息气泡里，全局按文本搜会点错地方（踩过两次）。
 *   用 `aria-current` 认「当前是哪条」，再取它的邻居 —— 不依赖任何文案。
 */
export const clickNeighbour = `(function(){
  const bar = document.querySelector('[aria-label="侧边栏"]')
  if (!bar) return false
  const cur = bar.querySelector('[aria-current="true"]')
  const rows = [...bar.querySelectorAll('[role="button"]')]
  const other = rows.find((r) => r !== cur && (r.textContent || '').trim())
  if (!other) return false
  other.click()
  return true
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
 * 读的都是界面自己标出来的事实（`data-*`），不猜文案、不数像素：
 *   · 入口那一行字 + 有没有红叉（`data-process-failed`）
 *   · 每一项操作的状态词（成功 / 失败 / 进行中）与顺序
 *   · 失败项有没有给出**真实原因**，以及原文是不是被收起来了
 */
export const PROBE_PROCESS = `(function(){
  const entries = [...document.querySelectorAll('button[aria-label="查看过程"]')]
  const entry = entries[entries.length - 1]
  const panes = [...document.querySelectorAll('[data-process-open]')]
  const pane = panes[panes.length - 1]
  const rows = pane ? [...pane.querySelectorAll('[data-run-status]')] : []
  const lines = pane ? [...pane.querySelectorAll('[data-tool-status]')] : []
  const errors = pane ? [...pane.querySelectorAll('[data-run-error]')] : []
  const stateOf = (n) => n.getAttribute('data-run-status') || n.getAttribute('data-tool-status')
  return {
    entries: entries.length,
    entryText: entry ? (entry.textContent || '').trim() : null,
    failedMark: !!document.querySelector('[data-process-failed]'),
    open: !!pane,
    /*
     * 状态读**属性值**（completed / failed / running），不读文案 ——
     * 文案会随措辞改，属性是内核契约（图2 要的是「状态与顺序」，不是某几个字）。
     */
    statuses: rows.map(stateOf),
    statusTexts: rows.map((n) => (n.textContent || '').trim()),
    lineStatus: lines.map(stateOf),
    lineTexts: lines.map((n) => (n.textContent || '').trim()),
    errors: errors.map((n) => (n.textContent || '').trim().slice(0, 120)),
    /* 主区域里是不是还铺着大段原文（有 <pre> 就是没被收进次级区域） */
    rawPre: !!(pane && pane.querySelector('pre')),
    /* 展开区原文（调试 / 判据都能用：出问题时能直接看到界面到底写了什么） */
    paneText: pane ? (pane.innerText || '').replace(/\s+/g, ' ').slice(0, 600) : null,
    bodies: document.querySelectorAll('[data-round-body]').length,
  }
})()`

/**
 * 确保过程区是**展开**的（已经展开就不动）。
 *
 * ★ 为什么不直接 `TOGGLE`：失败 / 中断时过程**默认就是展开的**，
 *   再点一次反而把它收起来 —— 那样判据读到的是「没展开」，还以为是界面坏了。
 */
export const ENSURE_OPEN = `(function(){
  const panes = document.querySelectorAll('[data-process-open]')
  if (panes.length > 0) return 'already'
  const all = [...document.querySelectorAll('button[aria-label="查看过程"]')]
  const b = all[all.length - 1]
  if (!b) return 'no-entry'
  b.click()
  return 'clicked'
})()`

/** 读状态词的计算颜色（替代「人工看截图」：颜色对不对由样式证据说话） */
export const PROBE_COLORS = `(function(){
  const panes = [...document.querySelectorAll('[data-process-open]')]
  const pane = panes[panes.length - 1]
  if (!pane) return { rows: [] }
  const read = (n) => ({
    state: n.getAttribute('data-run-status') || n.getAttribute('data-tool-status'),
    text: (n.textContent || '').trim(),
    color: getComputedStyle(n).color,
  })
  /* 摘要行与明细行都收（成功组的明细默认是收起的，只有摘要行在） */
  const rows = [...pane.querySelectorAll('[data-tool-status], [data-run-status]')].map(read)
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
