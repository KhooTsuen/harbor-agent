/**
 * 触发页的**收尾**：关掉它、并复核它确实不在了（2026-10-20 拆出）
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────
 *
 * 从 `ext-panel.cjs` 拆出来的（那边贴 300 行红线）。这一半与「开侧栏」是两件事：
 * 前者是**开**（要找对 target、要真实点击），这里是**收**（还原真实场景）。
 * 拆开之后 `ext-panel` 只管「开 + 认出」，本文件只管「收干净」。
 *
 * ── 为什么「关 0 个」不等于失败 ────────────────────────────────
 *
 * 真机实测（`accept-ownership` 连跑两次）：`sidePanel.open()` 之后，浏览器
 * **有时会自己把触发页收掉**。此时没东西可关，`closed = 0` —— 但真实场景
 * 要求的是「触发页不在」，所以判据得看 `remaining`，不是看 `closed`。
 * 只看 `closed >= 1` 会造出一条**时红时绿**的判据（我第一版就是那么写的）。
 *
 * marker 判据（`window.__harborTrigger`）只有一份实现 —— 在 `ext-panel.cjs`。
 */

const { connect, closeTrigger, MARK } = require('./ext-panel.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 当前属于这个扩展的 page target（带 ws 地址） */
async function extPageTargets(port, extId) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  return list.filter((x) => x.type === 'page' && String(x.url || '').includes(extId))
}

/** 问一个 target「你是触发页吗」；读不到（已关 / 正在加载）一律当「不是」 */
async function isTrigger(target) {
  let conn
  try {
    conn = await connect(target.webSocketDebuggerUrl)
    return (await conn.evalIn(`window.${MARK} === true`)) === true
  } catch {
    return false
  } finally {
    if (conn) conn.close()
  }
}

/**
 * 关掉本轮用来触发的那一页（带 marker 的那个），并复核它确实不在了。
 *
 * @returns {Promise<{ closed: number, remaining: number, note: string }>}
 */
async function closeTriggerPages(port, extId) {
  let closed = 0
  for (const t of await extPageTargets(port, extId)) {
    if (await isTrigger(t)) {
      await closeTrigger(port, t.id)
      closed += 1
    }
  }
  await sleep(500)
  let remaining = 0
  for (const t of await extPageTargets(port, extId)) {
    if (await isTrigger(t)) remaining += 1
  }
  return {
    closed,
    remaining,
    note: closed === 0 && remaining === 0 ? '（浏览器已自行收掉触发页）' : '',
  }
}

module.exports = { closeTriggerPages, extPageTargets, isTrigger }
