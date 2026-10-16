/**
 * M04 剩余：**填表 / 滚动 / 等待 / 导航** 的扩展侧执行（`command-run.js` 转给这里）
 *
 * ── 为什么与 command-run.js 分开 ──────────────────────────────
 *
 * 那边已有 get-elements / click / verify 三个分支 + 分派链；这五个再塞进去会顶到
 * 300 红线。拆开后职责也干净：**这边只管「页面动作」，注入与证据都在这里**。
 *
 * ── ★ 每个动作都要「证据」，不只回 ok ────────────────────────
 *
 * 与 click 同一口径（用户定的硬要求）：`type` 回 value 前后、`select` 回选中项、
 * `scroll` 回 scrollY 前后、`navigate` 回 url 前后。调用方据此判断有没有达到目的。
 */

/* global chrome */

import { typeText, selectOption } from './act-form.js'
import { scrollPage } from './act-nav.js'
import { focusElement, pressKey } from './act-edit.js'
import { verifyPage } from './act.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 注入 + 超时上限（与 `command-run.js` 同一个理由：导航会让注入 promise 永不 resolve） */
async function injectBounded(tabId, fn, args, timeoutMs) {
  let timer = null
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs)
  })
  try {
    return await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, func: fn, args }).then((r) => (r && r[0] ? r[0].result : null)),
      guard,
    ])
  } catch (error) {
    return { ok: false, error: `注入失败：${(error && error.message) || error}` }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 包装注入结果：超时 / null 都变成人话失败（别让调用方拿到 undefined） */
function unwrap(raw, what) {
  if (raw && typeof raw === 'object' && raw.__timeout === true) {
    return {
      ok: false,
      reason: 'no-result',
      error: `${what}指令发出去了，但页面没把结果送回来（可能正在跳转）—— 请用 browser.verify 确认状态`,
    }
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: `页面没返回${what}的结果` }
  }
  return raw
}

/** `wait`：在**扩展侧**轮询 `verifyPage` —— 条件语义只有那一处实现（硬约束 #9） */
async function waitFor(tabId, expect, timeoutMs) {
  const budget = Math.max(500, Math.min(Number(timeoutMs) || 10000, 60000))
  const t0 = Date.now()
  let polls = 0
  let last = null
  while (Date.now() - t0 < budget) {
    const raw = await injectBounded(tabId, verifyPage, [expect || {}], 8000)
    polls += 1
    if (raw && typeof raw === 'object' && raw.matched === true) {
      return { ...raw, waitedMs: Date.now() - t0, polls, timedOut: false }
    }
    last = raw && typeof raw === 'object' ? raw : null
    await sleep(300)
  }
  return {
    ok: true,
    matched: false,
    timedOut: true,
    waitedMs: Date.now() - t0,
    polls,
    checks: (last && last.checks) || [],
    url: (last && last.url) || '',
    title: (last && last.title) || '',
    message: `等了 ${Date.now() - t0}ms，期望的条件一直没满足 —— 页面**没变到你等的那个样子**（不是报错，是「还没/没有」）`,
  }
}

/** `navigate`：`chrome.tabs.update` + 等加载完（带上限） */
async function navigateTo(tabId, url, beforeUrl) {
  const want = String(url || '').trim()
  if (!want) return { ok: false, error: '没给要去的地址' }
  /* 等 onUpdated 的 complete —— 但**必须有上限**（页面永远加载不完也要回话） */
  const done = new Promise((resolve) => {
    const onUpdated = (tid, info) => {
      if (tid !== tabId) return
      if (info && info.status === 'complete') {
        try {
          chrome.tabs.onUpdated.removeListener(onUpdated)
        } catch {
          /* 忽略 */
        }
        resolve(true)
      }
    }
    try {
      chrome.tabs.onUpdated.addListener(onUpdated)
    } catch {
      /* 不支持就退化成下面的超时 */
    }
    setTimeout(() => {
      try {
        chrome.tabs.onUpdated.removeListener(onUpdated)
      } catch {
        /* 忽略 */
      }
      resolve(false)
    }, 15000)
  })

  let threw = ''
  try {
    await chrome.tabs.update(tabId, { url: want })
  } catch (error) {
    threw = String((error && error.message) || error)
  }
  const completed = threw === '' ? await done : false

  let urlAfter = ''
  let title = ''
  try {
    const t = await chrome.tabs.get(tabId)
    urlAfter = String((t && t.url) || '')
    title = String((t && t.title) || '')
  } catch {
    /* 标签没了 */
  }
  return {
    ok: threw === '' && Boolean(urlAfter) && urlAfter !== beforeUrl,
    threw,
    completed,
    evidence: { urlBefore: beforeUrl, urlAfter, urlChanged: urlAfter !== beforeUrl, titleAfter: title, loadCompleted: completed },
    checks: [
      { name: 'url-changed', pass: urlAfter !== beforeUrl, before: beforeUrl, after: urlAfter },
      { name: 'load-completed', pass: completed, before: '', after: String(completed) },
    ],
  }
}

/**
 * 跑一个「页面动作」。
 *
 * @param {string} command type / select / scroll / wait / navigate
 * @param {{ id: number, url?: string }} tab
 * @param {object} args
 * @returns {Promise<object|null>} 不认识的 command → `null`（让调用方走别的分支）
 */
export async function runPageAction(command, tab, args) {
  const a = args && typeof args === 'object' ? args : {}
  if (command === 'type') {
    const raw = await injectBounded(tab.id, typeText, [String(a.ref ?? ''), { text: a.text, clear: a.clear }], 8000)
    return unwrap(raw, '填写')
  }
  if (command === 'select') {
    const raw = await injectBounded(
      tab.id,
      selectOption,
      [String(a.ref ?? ''), { value: a.value, label: a.label, index: a.index }],
      8000,
    )
    return unwrap(raw, '选择')
  }
  if (command === 'scroll') {
    const raw = await injectBounded(tab.id, scrollPage, [{ ref: a.ref, to: a.to, dy: a.dy }], 8000)
    return unwrap(raw, '滚动')
  }
  if (command === 'wait') {
    return waitFor(tab.id, a.expect, a.timeoutMs)
  }
  /* M04 补齐：clear 复用 `type` 的空文本（不另写一个注入函数 —— 少一处能漂的实现） */
  if (command === 'clear') {
    const raw = await injectBounded(tab.id, typeText, [String(a.ref ?? ''), { text: '', clear: true }], 8000)
    return unwrap(raw, '清空')
  }
  if (command === 'focus') {
    const raw = await injectBounded(tab.id, focusElement, [String(a.ref ?? '')], 8000)
    return unwrap(raw, '聚焦')
  }
  if (command === 'key') {
    const raw = await injectBounded(tab.id, pressKey, [String(a.ref ?? ''), String(a.key ?? 'Enter')], 8000)
    return unwrap(raw, '按键')
  }
  if (command === 'navigate') {
    return navigateTo(tab.id, a.url, String(tab.url || ''))
  }
  return null
}
