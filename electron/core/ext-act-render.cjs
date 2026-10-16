/**
 * M04：**页面动作的结果 → markdown**（从 `ext-actions.cjs` 拆出来）
 *
 * ── 为什么拆 ─────────────────────────────────────────────────
 *
 * `ext-actions.cjs` 加完「M04 补齐」的三个动作（clear / focus / key）就会破 300 行。
 * 而这两块职责本来就分得开：**这边纯渲染**（输入结果对象、输出 markdown，无副作用、
 * 可单独喂假数据测），那边是**动作执行**（校验引用 → 发指令 → 落盘）。
 *
 * ⚠️ 本模块**不 require electron**（自检要能在纯 Node 里直接跑它）。
 */

/** 渲染结果的字符预算（与 ext-observe 同一口径） */
const MAX_CHARS = 20_000

/** 表格单元格里的 `|` 会撕坏 markdown 表格 */
const cell = (s) => String(s === null || s === undefined ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** 一行「键：值」，空值也写（如实比好看重要） */
const kv = (k, v) => `- ${k}：${v === '' || v === null || v === undefined ? '（空）' : v}`

/** 收尾：拼 markdown + 超预算截断（本文件所有渲染器共用） */
function finish(lines, maxChars = MAX_CHARS) {
  let md = lines.join('\n')
  let truncated = false
  if (md.length > maxChars) {
    md = `${md.slice(0, maxChars)}\n\n（结果过长，已截断）`
    truncated = true
  }
  return { markdown: md, truncated, chars: md.length }
}

/** 有证据的动作：渲染一张「动作 + 前后对比」表 */
function renderEvidence(title, res, rows) {
  const lines = [`## 页面操作：${title}`, '']
  const ev = res && res.evidence && typeof res.evidence === 'object' ? res.evidence : {}
  if (res && res.ok === false && res.reason) {
    lines.push(`- 结果：**没有完成**（${cell(res.reason)}）`, '')
    if (res.message) lines.push(`- 说明：${cell(res.message)}`, '')
  } else {
    lines.push(`- 结果：${res && res.ok === true ? '执行完成' : '执行了但结果异常'}`, '')
  }
  const body = (rows || []).map(([k, v]) => kv(k, v)).filter(Boolean)
  if (body.length) lines.push(...body, '')
  if (Object.keys(ev).length) {
    lines.push('| 项 | 之前 | 之后 |', '|---|---|---|')
    for (const [k, v] of Object.entries(ev)) {
      if (/Before$/.test(k)) {
        const afterKey = k.replace(/Before$/, 'After')
        lines.push(`| ${cell(k.replace(/Before$/, ''))} | ${cell(v)} | ${cell(ev[afterKey])} |`)
      }
    }
    lines.push('')
  }
  if (Array.isArray(res && res.checks) && res.checks.length) {
    lines.push('| 检查 | 期望 | 实际 | 命中 |', '|---|---|---|---|')
    for (const c of res.checks) {
      const ch = c && typeof c === 'object' ? c : {}
      lines.push(`| ${cell(ch.name)} | ${cell(ch.expected)} | ${cell(ch.actual)} | ${ch.pass === true ? '是' : '否'} |`)
    }
    lines.push('')
  }
  return finish(lines, MAX_CHARS)
}

/** 敏感字段被拒：**说清「没有写进去」**，并告诉调用方该怎么做 */
function renderSensitive(res) {
  const r = res && typeof res === 'object' ? res : {}
  const isPwd = r.field === 'password'
  return finish(
    [
      '## 页面操作：填写文本',
      '',
      `- 结果：**拒绝执行**（${isPwd ? '密码字段' : '信用卡字段'}）`,
      `- 说明：${cell(r.message || '按隐私规矩不代填这类字段')}`,
      '',
      '**页面没有被改动** —— 一个字节都没有写进去。',
      '',
      `→ 这一步需要**你自己输入**（${isPwd ? '密码' : '支付信息'}不该经过模型）。`,
      '填完之后可以让我继续做后面的步骤。',
    ],
    MAX_CHARS,
  )
}

/** 选项没找到：把**可选值全列出来**（不然调用方只能瞎猜下一次试什么） */
function renderOptionNotFound(res) {
  const opts = Array.isArray(res.options) ? res.options : []
  const lines = ['## 页面操作：选择下拉项', '', '- 结果：**没找到这个选项**', '']
  if (opts.length) {
    lines.push('| # | 值 | 显示文本 |', '|---|---|---|')
    for (const o of opts) lines.push(`| ${cell(o.index)} | ${cell(o.value)} | ${cell(o.label)} |`)
    lines.push('')
  } else {
    lines.push('- 这个下拉框里**一个选项都没有**。', '')
  }
  return finish(lines, MAX_CHARS)
}

/** 等待：分成「等到了」与「等不到」两种写法（后者要如实说没等到） */
function renderWait(res) {
  const r = res && typeof res === 'object' ? res : {}
  const lines = ['## 页面操作：等待条件', '']
  const hit = r.matched === true
  lines.push(`- 结果：${hit ? '**条件满足了**' : '**等到了上限，条件一直没满足**'}`)
  lines.push(kv('等了多久', `${Number(r.waitedMs ?? 0)}ms（查了 ${Number(r.polls ?? 0)} 次）`))
  lines.push(kv('当前地址', String(r.url ?? '')))
  if (!hit) lines.push('', `- 这说明页面**没变成你等的那个样子**（不是报错）。${cell(r.message || '')}`)
  lines.push('')
  const checks = Array.isArray(r.checks) ? r.checks : []
  if (checks.length) {
    lines.push('| 条件 | 期望 | 实际 | 命中 |', '|---|---|---|---|')
    for (const c of checks) {
      const ch = c && typeof c === 'object' ? c : {}
      lines.push(`| ${cell(ch.name)} | ${cell(ch.expected)} | ${cell(ch.actual)} | ${ch.pass === true ? '是' : '否'} |`)
    }
    lines.push('')
  }
  return finish(lines, MAX_CHARS)
}

/** 导航：url 前后 + 是否加载完 */
function renderNavigate(res) {
  const r = res && typeof res === 'object' ? res : {}
  const ev = r.evidence && typeof r.evidence === 'object' ? r.evidence : {}
  return finish(
    [
      '## 页面操作：导航',
      '',
      `- 结果：${r.ok === true ? '**已经到新页面**' : '**没能导航过去**'}`,
      kv('之前', String(ev.urlBefore ?? '')),
      kv('之后', String(ev.urlAfter ?? '')),
      kv('加载完成', ev.loadCompleted === true ? '是' : '否（可能还在加载，或超时）'),
      '',
      r.ok === true ? '' : `- 说明：${cell(r.error || r.threw || '未知')}`,
      '',
    ].filter((x) => x !== null),
    MAX_CHARS,
  )
}

module.exports = {
  MAX_CHARS,
  cell,
  kv,
  finish,
  renderEvidence,
  renderSensitive,
  renderOptionNotFound,
  renderWait,
  renderNavigate,
}
