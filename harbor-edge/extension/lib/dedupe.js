/**
 * 指令去重 —— 「同一条指令 2 秒内只执行一次」
 *
 * ── 上一版有四个洞（2026-10-20 用户逐条指出）──────────────────
 *
 *   ① 键只有 `command|ref|pageVersion` → **`type` 填不同文字被判重复**：
 *      「先填 A，再填 B」第二条会被静默拦掉，而界面看起来一切正常。
 *   ② `tabs-create` / `tabs-close` 在去重判断**之前**就 `return` 了 ——
 *      看起来在 `MUTATING` 名单里，实际**一次都没被去重过**（连点两次真开两个标签）。
 *   ③ 记录在**执行前**写 → 第一次失败（元素不存在、页面上没这个按钮）后
 *      立刻重试也会被拦 2 秒。用户的心智是「失败了当然能重试」。
 *   ④ 用 `command` 字符串当 ID，而不是「动作 + 目标 + 载荷」的稳定指纹。
 *
 * ── 现在的规矩 ─────────────────────────────────────────────────
 *
 *   · 只对**会产生副作用**的动作去重（表见 `MUTATING`）
 *   · 指纹 = 动作 + 目标 + **参与判定的载荷字段**（白名单 —— 不用 `Object.keys`
 *     把 `settleMs` 这类与「是不是同一个动作」无关的参数也算进去）
 *   · **执行之后**才记录，且只在「副作用真的发生了」时记录（见 `reallyHappened`）
 *   · 同一指纹 2 秒内再来 → 拒绝，回 `reason:'duplicate'`
 *
 * ★ 为什么白名单而不是黑名单：新动作加进来时，漏配白名单 = 该动作不去重
 *   （安全侧漏），漏配黑名单 = 把无关参数算进指纹 → 该拦的没拦（也是漏）。
 *   两者都不好，但白名单能让人一眼看出「每个动作到底比的是哪几个字段」。
 */

/** 去重窗口（毫秒）——用户 2026-10-20 拍板 2 秒 */
const DEDUPE_WINDOW_MS = 2000
/** 只记最近若干条（覆盖 2 秒窗即可，防无限增长） */
const DEDUPE_MAX = 32

/**
 * 会产生副作用的动作 → **参与指纹的载荷字段**（顺序即指纹顺序，保证稳定）。
 *
 * 不在这里的动作 = 不去重：
 *   · `get-elements` / `verify` / `wait` / `scroll` —— 重复执行无害
 *   · `focus` —— 只移焦点，不改内容
 *   · `tabs-list` / `tabs-search` / `tabs-activate` —— 只读或可逆的切换
 */
const MUTATING = {
  click: ['ref'],
  type: ['ref', 'text', 'clear'],
  select: ['ref', 'value', 'label', 'index'],
  clear: ['ref'],
  key: ['ref', 'key'],
  navigate: ['url'],
  'tabs-create': ['url'],
  'tabs-close': ['id'],
}

/** `指纹 → 上次执行时间`（Map 保插入序，超了从头删） */
const recent = new Map()

/** 这个动作要不要去重 */
export function isMutating(command) {
  return Object.prototype.hasOwnProperty.call(MUTATING, String(command ?? ''))
}

/**
 * 稳定指纹。不参与去重的动作返回空串（调用方据此跳过整段逻辑）。
 *
 * @param {string} command
 * @param {object} [args]
 * @returns {string}
 */
export function fingerprint(command, args) {
  const cmd = String(command ?? '')
  const fields = MUTATING[cmd]
  if (!fields) return ''
  const a = args && typeof args === 'object' ? args : {}
  const parts = []
  for (const k of fields) {
    const v = a[k]
    if (v === undefined || v === null) continue
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  }
  /* ref 本身已带元素引用。点击后的 DOM 版本可能立即变化；若把新版本也算入，
     同一按钮的第二次点击会穿过去，正好失去去重的保护。 */
  return `${cmd}|${parts.join('&')}`
}

/**
 * 这个指纹 2 秒内执行过吗。
 *
 * @param {string} key
 * @returns {boolean}
 */
export function seenRecently(key) {
  if (!key) return false
  const last = recent.get(key)
  if (last === undefined) return false
  if (Date.now() - last < DEDUPE_WINDOW_MS) return true
  /* 过期了：清掉，下一次重新开始计 */
  recent.delete(key)
  return false
}

/**
 * 记一笔「这个指纹真的执行过了」。
 *
 * ★ 只在**副作用真的发生之后**调 —— 这就是「失败后能立刻重试」的实现方式。
 *
 * @param {string} key
 */
export function markExecuted(key) {
  if (!key) return
  recent.delete(key)
  recent.set(key, Date.now())
  while (recent.size > DEDUPE_MAX) recent.delete(recent.keys().next().value)
}

/**
 * 这次结果算不算「副作用真的发生了」（**不是**「调用成功」）。
 *
 * 三种情况必须算「发生了」，否则重试会**再做一遍**：
 *   · `ok:true` —— 明确成功
 *   · 导航型（`reason:'navigating'` / `navigated:true`）—— 点下去了，页面开始跳
 *   · `timedOut:true` —— 注入的指令**已经发出去**了，只是结果没回来
 *     （`act-run.js` 的 `unwrap` 明确写着「指令发出去了」）
 *
 * 只有**明确报错**（元素不存在 / 页面拒填 / 没这个标签）才算「没发生」→ 允许立即重试。
 *
 * @param {object} result
 * @returns {boolean}
 */
export function reallyHappened(result) {
  if (!result || typeof result !== 'object') return false
  if (result.ok === true) return true
  if (result.reason === 'navigating' || result.navigated === true) return true
  if (result.timedOut === true) return true
  return false
}

/**
 * 统一的「被判重复」回执。成功/失败都是这个形状，模型能据此知道**不要重试**。
 *
 * @returns {object}
 */
export function duplicateResult() {
  return {
    ok: false,
    reason: 'duplicate',
    deduped: true,
    message:
      '同一条指令 2 秒内已经执行过（同一动作、同一目标、同一载荷）——**没有重复执行**。真要再来一次，请稍等或先改变要操作的内容。',
  }
}

/** 自检 / 验收用：清空去重记录（真机脚本连点两次不该受上一轮影响） */
export function resetDedupe() {
  recent.clear()
}
