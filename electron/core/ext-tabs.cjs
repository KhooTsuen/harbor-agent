/**
 * M05：`tabs.list` / `tabs.activate` / `tabs.search` 的**主进程侧**
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────
 *
 * `ext-command.cjs`（通道）与 `ext-actions.cjs`（页面动作）都贴线了，而这三件
 * 与「页面内操作」职责不同：**它们碰的是标签页**，不注入任何东西、也不校验元素引用。
 *
 * ── ★ 边界（三件共守）─────────────────────────────────────────
 *
 *   ① **不按 id 编造**：`activate` 的 id 必须**出现在 list 结果里**才允许切
 *      （由扩展侧 `tabs-run.js` 把关，这里只转）。否则网页/模型可以编一个 id
 *      去激活我们看不见的标签 —— 那就等于绕过「只看得到这几个」这条边界。
 *   ② **url 可能看不到**：`manifest` 刻意没有 `tabs` 权限（M07），所以只有
 *      activeTab 授予的那个标签能读到 url/title，其余带 `urlHidden: true`。
 *      **如实标出来**，不编假的，也不假装那条标签不存在。（渲染里会写明。）
 *
 * ⚠️ 本模块**不 require electron**（自检要能在纯 Node 里直接跑它）。
 */

const P = require('./ext-protocol.cjs')

const MAX_CHARS = 20_000
const cell = (s) => String(s === null || s === undefined ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ')

function finish(lines) {
  let md = lines.join('\n')
  let truncated = false
  if (md.length > MAX_CHARS) {
    md = `${md.slice(0, MAX_CHARS)}\n\n（结果过长，已截断）`
    truncated = true
  }
  return { markdown: md, truncated, chars: md.length }
}

/** 标签页表格 —— 三处共用（list / search / activate 的回读都用它） */
function tabsTable(tabs) {
  const lines = ['| # | 标签 id | 标题 | 地址 | 前台 |', '|---|---|---|---|---|']
  for (const t of tabs) {
    const title = t.urlHidden === true && !t.title ? '（看不到 —— 没被授权）' : cell(t.title) || '（无标题）'
    const url = t.urlHidden === true && !t.url ? '（看不到 —— 没被授权）' : cell(t.url) || '（空）'
    lines.push(`| ${cell(t.index)} | ${cell(t.id)} | ${title} | ${url} | ${t.active === true ? '★' : ''} |`)
  }
  return lines
}

/**
 * @param {{ call: (command: string, payload: object, timeoutMs?: number) => Promise<object>,
 *           landAction: (kind: string, result: object, meta: object) => object }} deps
 */
function createTabs(deps) {
  const call = deps.call
  const landAction = deps.landAction
  const fail = (code, message) => ({ ok: false, error: { code, message } })

  /** `tabs.list`：列出可访问的标签页 */
  async function list() {
    const res = await call('tabs-list', {}, 12000)
    if (!res || typeof res !== 'object') return fail(P.ERR.INTERNAL, '浏览器没回可用的结果')
    if (res.ok !== true) return res.error ? res : fail(P.ERR.INTERNAL, res.error || '拿不到标签页列表')
    return landAction('tabs-list', res, { count: (res.tabs || []).length })
  }

  /** `tabs.search`：按标题 / 地址子串搜（口径 = 先 list 再过滤，只有一处实现） */
  async function search(payload = {}) {
    const query = String(payload.query ?? '').trim()
    if (!query) return fail(P.ERR.INTERNAL, '没给搜索词')
    const res = await call('tabs-search', { query }, 12000)
    if (!res || typeof res !== 'object') return fail(P.ERR.INTERNAL, '浏览器没回可用的结果')
    if (res.ok !== true) return res.error ? res : fail(P.ERR.INTERNAL, res.error || '搜不了标签页')
    return landAction('tabs-search', res, { query, count: (res.tabs || []).length })
  }

  /** `tabs.activate`：切到某个标签（id 必须来自 list —— 扩展侧把关） */
  async function activate(payload = {}) {
    const id = Number(payload.id)
    if (!Number.isFinite(id)) return fail(P.ERR.INTERNAL, '没给要切过去的标签 id（先用 tabs.list 看一眼）')
    const res = await call('tabs-activate', { id }, 12000)
    if (!res || typeof res !== 'object') return fail(P.ERR.INTERNAL, '浏览器没回可用的结果')
    if (res.reason === 'not-in-list') return { ok: false, error: { code: P.ERR.NO_TAB, message: String(res.error || '这个标签不在能操作的列表里') }, id }
    if (res.ok !== true) return res.error ? res : fail(P.ERR.NO_TAB, '切不过去')
    return landAction('tabs-activate', res, { id })
  }

  return { list, search, activate }
}

/* ── 渲染（与动作同住，就近）────────────────────────────────── */

function renderTabs(res, opts) {
  const r = res && typeof res === 'object' ? res : {}
  const tabs = Array.isArray(r.tabs) ? r.tabs : []
  const o = opts && typeof opts === 'object' ? opts : {}
  const lines = ['## 标签页', '']
  if (o.query) lines.push(`- 搜索词：${cell(o.query)}（在 ${Number(r.scanned ?? 0)} 个标签里找到 ${tabs.length} 个）`)
  else lines.push(`- 一共有 ${tabs.length} 个可以操作的标签页`)
  lines.push('')
  if (!tabs.length) {
    lines.push(o.query ? '（没有匹配的标签页）' : '（没有可以操作的标签页）', '')
    return finish(lines)
  }
  lines.push(...tabsTable(tabs), '')
  if (tabs.some((t) => t.urlHidden === true)) {
    lines.push(
      '> ⚠️ 有标签的地址显示「看不到」：扩展**没有申请 `tabs` 权限**（不默认看全站），',
      '> 只有它被授权过的那个标签能读出地址 —— 这是**如实标注**，不是「没有地址」。',
      '',
    )
  }
  return finish(lines)
}

function renderActivate(res) {
  const r = res && typeof res === 'object' ? res : {}
  const lines = ['## 标签页：切换', '']
  lines.push(`- 结果：${r.ok === true ? `**已经切到标签 ${cell(r.id)}**` : '**没能切过去**'}`, '')
  if (r.active && typeof r.active === 'object') {
    lines.push('| 项 | 值 |', '|---|---|')
    lines.push(`| 标签 id | ${cell(r.active.id)} |`)
    lines.push(`| 标题 | ${cell(r.active.title) || '（看不到 —— 没被授权）'} |`)
    lines.push(`| 地址 | ${cell(r.active.url) || '（看不到 —— 没被授权）'} |`)
    lines.push('')
  }
  lines.push('> 这条是**回读确认**的结果（切完真去看了一眼谁在前台），不是「调用了就算成功」。')
  return finish(lines)
}

module.exports = { createTabs, renderTabs, renderActivate, tabsTable }
