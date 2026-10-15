/**
 * M05：标签页三件（list / activate / search）—— 扩展侧实现
 *
 * ── ★ 为什么单独一个文件 ──────────────────────────────────────
 *
 * `command-run.js` 已经有 8 个 `command` 分支（get-elements / click / verify + 这批新增的
 * type / select / scroll / wait / navigate）。tabs 这三件与「页面内操作」职责不同
 * （它们碰的是**标签页**，不注入任何东西），所以单独放一处。
 *
 * ── ★★ 一个必须如实说的边界：url / title 可能拿不到 ────────────
 *
 * `manifest.json` **刻意没有** `tabs` 权限（M07「不默认要全站权限」）。没有它时
 * `chrome.tabs.query` 返回的 tab 只有 `id / index / active / windowId` 这类**结构字段**，
 * `url` / `title` **是空的**（浏览器刻意隐藏，防扩展偷看用户所有网页）。
 *
 * 唯一例外：**被 activeTab 授予的那个标签**（= 用户点过图标 / 扩展操作过的那个）
 * 能读到 url / title。
 *
 * 所以这三件的口径是：**该列的照列**（id/index/active 都给），拿不到的字段**如实标
 * `urlHidden: true`** —— 不编一个假 url，也不假装「这条标签不存在」。
 * （要全量 url/title 就得加 `tabs` 权限；那是一次权限扩张，见本批报告「遗留」。）
 */

/* global chrome */

/** 只把「能用扩展操作」的标签算进来：浏览器内部页 / 扩展页一律不提（与 Phase 2 同一口径） */
const BLOCKED = /^(chrome|edge|about|devtools|view-source|chrome-extension|edge-extension|moz-extension|chrome-untrusted|file):/i

/**
 * 列标签页。
 *
 * @returns {Promise<{ ok: boolean, tabs?: object[], error?: string }>}
 */
export async function listTabs() {
  let raw = []
  try {
    raw = await chrome.tabs.query({})
  } catch (error) {
    return { ok: false, error: `拿不到标签页列表：${(error && error.message) || error}` }
  }
  const tabs = []
  for (const t of raw) {
    const url = String(t.url || '')
    /* ★ 拿不到 url 时**别猜**它是不是内部页 —— 那种标签照列，只是标 urlHidden（下面） */
    if (url && BLOCKED.test(url)) continue
    tabs.push({
      id: t.id,
      index: Number(t.index ?? 0),
      active: t.active === true,
      windowId: t.windowId ?? null,
      title: String(t.title || ''),
      url,
      /* 没有 tabs 权限时 url 就是空的 —— 这条标记让调用方知道「不是没有 url，是看不到」 */
      urlHidden: url === '',
    })
  }
  tabs.sort((a, b) => a.index - b.index)
  return { ok: true, tabs }
}

/**
 * 按标题 / URL 子串搜（不区分大小写）。
 *
 * ★ 为什么是「本地过滤」而不是 `chrome.tabs.query({ url })`：后者的 url 匹配要 `tabs`
 *   权限（我们没要），而且它**不匹配标题**。这里直接复用 `listTabs()` 的结果 ——
 *   口径只有一处，也顺带保证「搜出来的必然在 list 里」。
 *
 * @param {string} query
 */
export async function searchTabs(query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return { ok: false, error: '没给搜索词' }
  const all = await listTabs()
  if (all.ok !== true) return all
  const hit = (all.tabs || []).filter(
    (t) => String(t.title).toLowerCase().includes(q) || String(t.url).toLowerCase().includes(q),
  )
  return { ok: true, tabs: hit, query: q, scanned: (all.tabs || []).length }
}

/**
 * 切到某个标签页。
 *
 * ★★ 安全边界：`id` **必须**在 `listTabs()` 里出现过才允许切。
 *   不这么做的话，网页/模型可以编一个 id 让我们去激活**任何**标签（包括我们看不到的那些）——
 *   等于绕过「只看得到这几个」的边界。
 *
 * @param {{ id?: number|string }} [args]
 */
export async function activateTab(args) {
  const want = Number(args && args.id)
  if (!Number.isFinite(want)) return { ok: false, error: '没给要切过去的标签 id' }

  const all = await listTabs()
  if (all.ok !== true) return all
  const found = (all.tabs || []).find((t) => Number(t.id) === want)
  if (!found) {
    return {
      ok: false,
      reason: 'not-in-list',
      error: '这个标签不在能操作的列表里（可能已关闭，或是浏览器内部页）—— 先 tabs.list 看一遍',
      id: want,
    }
  }

  try {
    await chrome.tabs.update(want, { active: true })
    if (found.windowId !== null) {
      try {
        await chrome.windows.update(found.windowId, { focused: true })
      } catch {
        /* 窗口聚焦失败不影响「标签已切」（浏览器在后台时常见） */
      }
    }
  } catch (error) {
    return { ok: false, error: `切不过去：${(error && error.message) || error}`, id: want }
  }

  /* 回读确认（不信「调用了就成功」）—— 真去看一眼谁在前台 */
  let active = null
  try {
    const after = await chrome.tabs.query({ active: true })
    const a = (after || []).find((t) => Number(t.windowId) === Number(found.windowId)) || (after || [])[0]
    if (a) active = { id: a.id, title: String(a.title || ''), url: String(a.url || '') }
  } catch {
    active = null
  }
  return {
    ok: active !== null && Number(active.id) === want,
    id: want,
    active,
    requested: { id: found.id, index: found.index, title: found.title },
  }
}
