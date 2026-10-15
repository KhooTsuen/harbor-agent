/**
 * M03：把「页面观察」渲染成**给人看 / 给模型读**的 markdown（Phase 3d）
 *
 * ── 为什么单独一个文件 ───────────────────────────────────────
 *
 * `ext-ops.cjs` 已 179 行，再加一段渲染 + 预算就贴着 300 红线；而这块是**纯函数**
 * （输入观察对象、输出 markdown），自检能直接喂假数据跑，不必起管道。硬约束 #9：
 * 「观察结果 → 文本」这件事只有这一份实现。
 *
 * ── 两条不能忘的规矩 ─────────────────────────────────────────
 *
 *   ① **不捏造**：跨域 iframe 只说「读不到 + 为什么」，不填任何内容字段；
 *      closed shadow root 只说「无法枚举」，不猜数量。
 *   ② **敏感字段永不出现在文本里**：采集器已把 `value` 置 null，这里再兜一次
 *      （`masked` 的元素只写「（敏感字段，不读取）」）—— 防的是将来有人改采集器。
 *
 * 形状与预算见 `docs/research/edge-extension-m03-design.md`（唯一真相源）。
 *
 * ⚠️ 本模块**不 require electron**（自检要能在纯 Node 里直接跑它）。
 */

/** 渲染结果的字符预算（文档 §6：输出必须有预算） */
const MAX_CHARS = 20_000

/** 表格单元格里的 `|` 会撕坏 markdown 表格 */
const cell = (s) => String(s === null || s === undefined ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** 一行「键: 值」，空值也写（如实比好看重要） */
const kv = (k, v) => `- ${k}：${v === '' || v === null || v === undefined ? '（空）' : v}`

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
    lines.push('| # | 角色 | 文本 | 状态 | 引用 |')
    lines.push('|---|---|---|---|---|')
    elements.forEach((el, i) => {
      const e = el && typeof el === 'object' ? el : {}
      /* ★ 敏感字段：连 value 都不进文本（采集器已置 null，这里再兜一次） */
      const text = e.masked === true ? '（敏感字段，不读取）' : cell(e.text) || '（无文本）'
      const state = []
      if (e.disabled === true) state.push('disabled')
      if (e.checked === true) state.push('已选中')
      else if (e.checked === false) state.push('未选中')
      if (e.masked === true) state.push('敏感')
      lines.push(`| ${i + 1} | ${cell(e.role)} | ${text} | ${state.join(' ') || '—'} | ${cell(e.ref)} |`)
    })
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

  let markdown = lines.join('\n')
  let truncated = false
  if (markdown.length > MAX_CHARS) {
    markdown = `${markdown.slice(0, MAX_CHARS)}\n\n（观察结果过长，已截断）`
    truncated = true
  }
  return { markdown, truncated, chars: markdown.length }
}

module.exports = { renderObservation, MAX_CHARS }
