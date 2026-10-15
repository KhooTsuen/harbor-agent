/* M03 / M04：把「观察 / 元素列表 / 点击验证 / 填表 / 标签页」的结果渲染成给人看、给模型读的
   markdown（纯函数，自检直接喂假数据跑）。硬约束 #9：结果 → 文本只有这一份实现。
   ★ 两条规矩：① **不捏造**（跨域 iframe 只说读不到 + 为什么，不填内容字段）；
   ② **敏感字段永不出现在文本里**（采集器已置 null，这里再兜一次）。
   形状见 docs/research/edge-extension-m03-design.md。
   ⚠️ 不 require electron（自检要能裸跑）。 */

/** 渲染结果的字符预算（文档 §6：输出必须有预算） */
const MAX_CHARS = 20_000

/** 表格单元格里的 `|` 会撕坏 markdown 表格 */
const cell = (s) => String(s === null || s === undefined ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** 一行「键: 值」，空值也写（如实比好看重要） */
const kv = (k, v) => `- ${k}：${v === '' || v === null || v === undefined ? '（空）' : v}`

/**
 * 可交互元素表格 —— **唯一一份实现**（完整观察与 `getElements` 共用，硬约束 #9）。
 *
 * ★ 敏感字段：连 `value` 都不进文本（采集器已置 null，这里再兜一次）。
 */
function elementsTable(elements) {
  const lines = ['| # | 角色 | 文本 | 状态 | 引用 |', '|---|---|---|---|---|']
  elements.forEach((el, i) => {
    const e = el && typeof el === 'object' ? el : {}
    const text = e.masked === true ? '（敏感字段，不读取）' : cell(e.text) || '（无文本）'
    const state = []
    if (e.disabled === true) state.push('disabled')
    if (e.checked === true) state.push('已选中')
    else if (e.checked === false) state.push('未选中')
    if (e.masked === true) state.push('敏感')
    lines.push(`| ${i + 1} | ${cell(e.role)} | ${text} | ${state.join(' ') || '—'} | ${cell(e.ref)} |`)
  })
  return lines
}

/**
 * 观察结果 → markdown。
 *
 * @param {object} obs `harbor-edge/extension/lib/observe.js` 的返回值
 * @returns {{ markdown: string, truncated: boolean, chars: number }}
 */
function renderObservation(obs) {
  const o = obs && typeof obs === 'object' ? obs : {}
  const stats = o.stats && typeof o.stats === 'object' ? o.stats : {}
  const lines = []

  lines.push('## 页面观察', '')
  lines.push(kv('来源 URL', String(o.url ?? '')))
  lines.push(kv('标题', String(o.title ?? '')))
  lines.push(kv('语言', String(o.lang ?? '')))
  /* ★ 版本号给模型看的意义：引用它给的 ref 时，得知道是哪一版的页面 */
  lines.push(kv('页面版本', String(o.pageVersion ?? '')))
  lines.push(
    kv(
      '可交互元素',
      `${Number(stats.elements ?? 0)} 个${stats.truncated ? `（页面上更多，只列了前 ${Number(stats.maxItems ?? 0)} 个）` : ''}`,
    ),
  )
  lines.push('')

  /* ── 选区 ── */
  const sel = o.selection
  if (sel && String(sel.text ?? '').trim()) {
    lines.push('### 用户选中的内容', '')
    lines.push(`> ${String(sel.text).split('\n').join('\n> ')}`, '')
    lines.push(kv('所在元素', `${cell(sel.tag)}${sel.ref ? ` · 引用 ${cell(sel.ref)}` : ''}${sel.truncated ? '（选区过长，已截断）' : ''}`))
  } else {
    lines.push('### 用户选中的内容', '', '（没有选中任何内容）')
  }
  lines.push('')

  /* ── 可交互元素 ── */
  const elements = Array.isArray(o.elements) ? o.elements : []
  lines.push('### 可交互元素', '')
  if (!elements.length) {
    lines.push('（这个页面上没有可见的可交互元素）', '')
  } else {
    lines.push(...elementsTable(elements))
    lines.push('')
    lines.push('> 想让 Agent 点某个元素或往某个输入框填字，就用上表「引用」列的值 —— 页面变了引用会失效，需要重新观察。', '')
  }

  /* ── iframe（读不到就说清为什么，**不捏造内容**）── */
  const frames = Array.isArray(o.frames) ? o.frames : []
  lines.push('### 内嵌框架（iframe）', '')
  if (!frames.length) {
    lines.push('（这个页面没有 iframe）', '')
  } else {
    frames.forEach((f) => {
      const fr = f && typeof f === 'object' ? f : {}
      const where = fr.index === -1 ? '（未逐个检查）' : `#${Number(fr.index ?? 0)}`
      if (fr.accessible === true) lines.push(`- ${where} 可读取${fr.src ? `：${cell(fr.src)}` : ''}`)
      else lines.push(`- ${where} **读不到**：${cell(fr.reason) || '原因未知'}${fr.src ? `（${cell(fr.src)}）` : ''}`)
    })
    lines.push('')
  }

  /* ── shadow DOM ── */
  const shadow = o.shadow && typeof o.shadow === 'object' ? o.shadow : {}
  lines.push('### Shadow DOM', '')
  lines.push(kv('open（可读）', `${Number(shadow.open ?? 0)} 个`))
  if (shadow.note) lines.push(kv('说明', String(shadow.note)))
  lines.push('')

  return finish(lines)
}

/* 「元素列表」视图（M04-1 browser.getElements）：**只要元素**（不渲染选区 / iframe / shadow）。
   传了 `ref` 就把**引用解析结果**写在最前：失效要说清为什么 + 要求重新观察。
   @param {object} obs 采集器返回值   @param {{ ref?: string, parsed?: object }} [opts] */
function renderElements(obs, opts = {}) {
  const o = obs && typeof obs === 'object' ? obs : {}
  const ref = String(opts.ref ?? '')
  const parsed = opts.parsed && typeof opts.parsed === 'object' ? opts.parsed : null
  const elements = Array.isArray(o.elements) ? o.elements : []
  const lines = ['## 页面元素', '']
  lines.push(kv('来源 URL', String(o.url ?? '')))
  lines.push(kv('标题', String(o.title ?? '')))
  lines.push(kv('页面版本', String(o.pageVersion ?? '')), '')

  if (ref) {
    lines.push('### 你指定的元素', '')
    if (parsed && parsed.stale === true) {
      const why =
        parsed.reason === 'page-changed'
          ? `页面已经变了（引用是 ${cell(parsed.version)} 版，当前是 ${cell(parsed.currentVersion)} 版）`
          : '这个元素不在当前页面的可交互列表里（可能被移除，或已不可交互）'
      lines.push(`**引用 ${cell(ref)} 已失效**：${why}。`, '')
      lines.push('→ 必须用下面**当前**这一版的引用重新指定，否则会点错东西。', '')
    } else if (parsed && parsed.element) {
      const e = parsed.element
      const state = []
      if (e.disabled === true) state.push('disabled')
      if (e.checked === true) state.push('已选中')
      if (e.masked === true) state.push('敏感')
      lines.push(kv('引用', cell(e.ref)))
      lines.push(kv('角色 / 标签', `${cell(e.role)} / ${cell(e.tag)}`))
      lines.push(kv('文本', e.masked === true ? '（敏感字段，不读取）' : cell(e.text) || '（无文本）'))
      lines.push(kv('状态', state.join(' ') || '可用'), '')
    } else {
      lines.push('（没有解析结果）', '')
    }
  }

  lines.push('### 可交互元素', '')
  if (!elements.length) {
    lines.push('（这个页面上没有可见的可交互元素）', '')
  } else {
    lines.push(...elementsTable(elements))
    lines.push('', '> 引用格式 `<页面版本>.<序号>` —— 页面一变，旧引用即失效。', '')
  }

  return finish(lines)
}

/**
 * 收尾：拼 markdown + 超预算截断（**三个渲染器共用这一份**，硬约束 #9）。
 */
function finish(lines) {
  let markdown = lines.join('\n')
  let truncated = false
  if (markdown.length > MAX_CHARS) {
    markdown = `${markdown.slice(0, MAX_CHARS)}\n\n（结果过长，已截断）`
    truncated = true
  }
  return { markdown, truncated, chars: markdown.length }
}

/* 「点击 / 验证 / 填表…」的结果 → markdown。
   ★ 用户定的硬要求：**「点了」≠「生效」** —— 不写「点击成功」，而是把前后值并排摆出来
   （URL / 标题 / DOM / 目标元素），让模型自己判断这一下有没有产生效果。
   失效（page-changed / not-found）不是「操作失败」，是「你拿着过期引用，我没敢动」——
   必须让模型知道要重新观察。
   @param {string} kind   @param {object} result   @param {{ durationMs?: number, query?: string }} [meta] */
function renderAction(kind, result, meta = {}) {
  const r = result && typeof result === 'object' ? result : {}

  /*
   * ★ M04-3：新动作的渲染**住在 `ext-actions.cjs` / `ext-tabs.cjs`**（各自带着自己的
   *   渲染，就近）—— 这里只做**按 kind 转发**，不让本文件继续长大。
   *   本文件自己只管 click / verify / type / select 这四个（它们共用「页面操作」那张表）。
   */
  if (kind === 'wait' || kind === 'navigate' || kind === 'scroll') {
    const A = require('./ext-actions.cjs')
    if (kind === 'wait') return A.renderWait(r)
    if (kind === 'navigate') return A.renderNavigate(r)
    return A.renderEvidence('滚动', r, [['方式', cell(r.how)]])
  }
  if (kind === 'tabs-list' || kind === 'tabs-search') {
    /** @type {{ query?: string }} */
    const m2 = meta && typeof meta === 'object' ? meta : {}
    return require('./ext-tabs.cjs').renderTabs(r, { query: m2.query })
  }
  if (kind === 'tabs-activate') return require('./ext-tabs.cjs').renderActivate(r)

  /* type / select：敏感字段被拒、选项找不到各有专用渲染（说清「页面没被改动」/ 列出可选值） */
  if (kind === 'type' && r.reason === 'sensitive-field') return require('./ext-actions.cjs').renderSensitive(r)
  if (kind === 'select' && r.reason === 'option-not-found') return require('./ext-actions.cjs').renderOptionNotFound(r)
  if (kind === 'type') {
    return require('./ext-actions.cjs').renderEvidence('填写文本', r, [['字符数', cell(r.charCount)]])
  }
  if (kind === 'select') {
    const sel = r.selected && typeof r.selected === 'object' ? r.selected : {}
    return require('./ext-actions.cjs').renderEvidence('选择下拉项', r, [['选中', cell(sel.label) || cell(sel.value)]])
  }

  const isClick = kind === 'click'
  const lines = [isClick ? '## 页面操作：点击' : '## 页面验证', '']
  const ms = Number(meta.durationMs ?? 0)
  if (ms > 0) lines.push(kv('耗时', `${ms} ms`))
  if (r.ref) lines.push(kv('引用', cell(r.ref)))

  /* ── 先处理「没执行」的两种情形：引用失效 / 页面那边报错 ── */
  if (r.reason === 'page-changed' || r.reason === 'not-found') {
    lines.push(kv('结果', '**没有执行** —— 元素引用已失效'), '')
    lines.push(`- 原因：${cell(r.message) || (r.reason === 'page-changed' ? '页面已变化' : '元素已不在页面上')}`)
    if (r.refVersion || r.version) {
      lines.push(kv('引用属于的版本', cell(r.refVersion)), kv('当前页面版本', cell(r.version)))
    }
    lines.push('', '→ **重新观察页面**，用新拿到的引用再操作（否则会点错东西）。', '')
    return finish(lines)
  }
  if (r.reason === 'no-observation') {
    lines.push(kv('结果', '**没有执行** —— 还没观察过这个页面'), '')
    lines.push('→ 先观察页面（拿到元素引用），再操作。', '')
    return finish(lines)
  }
  /*
   * ★★ 「点了但证据没回来」—— 真机逮到的**真实情形**（M04-2）：点完页面就跳转了，
   *   注入的上下文被销毁，结果回不来。必须说清「**不代表没点上**」+ 下一步做什么，
   *   否则模型会以为失败而重试 —— 那一下可能已经点出去了，重试就点两次。
   */
  if (r.reason === 'no-result') {
    lines.push(kv('结果', '**点击发出去了，但状态证据没采到**'), '')
    if (r.navigated === true) {
      lines.push(kv('页面跳转到了', cell(r.urlAfter)), '')
      lines.push('（跳转发生在采证据之前 —— 页面换了，注入的那段代码跟着被销毁）', '')
    }
    lines.push('**这不代表没点上** —— 页面在把结果送回来之前就变了，所以这一下**可能已经生效**。')
    if (r.message) lines.push('', `- 扩展侧原话：${cell(r.message)}`)
    lines.push('', '→ 用 `browser.verify` 确认页面状态（或重新观察一次）。**不要直接重试点击** —— 可能点两次。', '')
    return finish(lines)
  }
  if (r.ok !== true) {
    lines.push(kv('结果', '**执行失败**'), '')
    if (r.error) lines.push(`- 原因：${cell(r.error)}`)
    if (r.threw) lines.push(`- 页面报错：${cell(r.threw)}`)
    lines.push('')
    return finish(lines)
  }

  /* ── 点击：摆出前后对比（这张表就是「状态证据」）── */
  if (isClick) {
    const ev = r.evidence && typeof r.evidence === 'object' ? r.evidence : {}
    lines.push(kv('结果', '已经点了（**这只是「点了」，不等于你要的效果发生了**）'), '')
    lines.push('### 点击前后的对比（自己判断有没有生效）', '')
    lines.push('| 信号 | 之前 | 之后 | 变化 |', '|---|---|---|---|')
    lines.push(
      `| URL | ${cell(ev.urlBefore)} | ${cell(ev.urlAfter)} | ${ev.urlChanged ? '**变了**' : '没变'} |`,
    )
    lines.push(
      `| 标题 | ${cell(ev.titleBefore)} | ${cell(ev.titleAfter)} | ${ev.titleChanged ? '**变了**' : '没变'} |`,
    )
    lines.push(
      `| DOM | ${Number(ev.nodesBefore ?? -1)} 节点 / ${Number(ev.textLenBefore ?? -1)} 字 | ${Number(ev.nodesAfter ?? -1)} 节点 / ${Number(ev.textLenAfter ?? -1)} 字 | ${ev.domChanged ? '**变了**' : '没变'} |`,
    )
    lines.push(`| 目标元素 | 在 | ${ev.targetStillThere ? '还在' : '**没了**'} | ${ev.targetStillThere ? '没变' : '**变了**'} |`)
    lines.push('', `（点完等了 ${Number(r.settledMs ?? 0)} ms 再采的对比）`, '')
    const anyChange = Boolean(ev.urlChanged || ev.titleChanged || ev.domChanged || !ev.targetStillThere)
    lines.push(
      anyChange
        ? '→ 页面**有变化** —— 但要不要接着做，得看变化是不是你要的那个（例如提交后出现的提示）。'
        : '→ 页面**一点没变**。可能是这个元素本来就没什么可做的，也可能需要等一会儿 / 先观察页面。',
      '',
    )
    return finish(lines)
  }

  /* ── 验证：逐条期望 vs 实际 ── */
  const checks = Array.isArray(r.checks) ? r.checks : []
  lines.push(kv('结果', r.matched === true ? '**全部符合**' : '**有不符的期望**'), '')
  if (!checks.length) {
    lines.push('（没有给任何期望 —— 没验到东西）', '')
    return finish(lines)
  }
  lines.push('| 期望 | 实际 | 命中 |', '|---|---|---|')
  checks.forEach((c) => {
    const ch = c && typeof c === 'object' ? c : {}
    lines.push(
      `| ${cell(ch.name)}：${cell(ch.expected)} | ${cell(ch.actual)} | ${ch.pass === true ? '是' : '**否**'} |`,
    )
  })
  lines.push('')
  return finish(lines)
}

module.exports = { renderObservation, renderElements, renderAction, elementsTable, MAX_CHARS }
