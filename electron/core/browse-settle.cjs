/**
 * 等页面「安静下来」（settle）—— 读元素 / 点 / 打字**之前**先确认页面加载完
 *
 * 为什么（2026-10-09 用户真机反馈）：读正文有「空则重读」（`browse-read.cjs`），
 * 读元素**没有** —— 网络慢 / SPA 还没渲染完时，snapshot 会如实返回**当时**那一小撮
 * 元素甚至空清单，模型拿它当即时结论（「这页没东西可点」），或者照旧索引去点、
 * 被「页面变了」拦下。不是那些保护错了，是**动手太早**：页面根本还没加载完。
 *
 * 判据（页面里跑探针，主进程侧循环采样）：
 *   · `document.readyState === 'complete'`
 *   · 可交互元素数与上次**相同**，连续 `quietSamples` 次 → 认定安静
 * 到上限还没安静就**如实返回 `settled: false`**，让工具告诉模型「可能还在加载」，
 * 而不是假装读到了最终状态。
 *
 * ⚠️ 顶层**不 require electron**（`cdp` 延迟到 `settle()` 里拿）—— 好让纯 Node
 *    自检 / jsdom 单测直接 require 本模块。
 */

const { INTERACTIVE_SEL } = require('./browse-ops.cjs')

/**
 * 探针脚本：在页面里跑一次，报告「准备得怎么样了」。
 *
 * `mutations` 用一个挂在 window 上的持久计数器（`MutationObserver` 只装一次）——
 * 主要给诊断看；**判定**只用 `readyState + interactions`（见 `stepQuiet`）：
 * 页面上有动画 / 轮播时 DOM 一直在动，拿 mutations 当「安静」判据会永远等不到。
 */
const PROBE_SCRIPT = `
  (function () {
    try {
      if (window.__harborMutCount === undefined) {
        window.__harborMutCount = 0
        try {
          var obs = new MutationObserver(function (list) { window.__harborMutCount += list.length })
          obs.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true })
        } catch (e) {}
      }
      return {
        readyState: document.readyState || '',
        interactions: document.querySelectorAll('${INTERACTIVE_SEL}').length,
        mutations: window.__harborMutCount || 0
      }
    } catch (e) {
      return { readyState: '', interactions: -1, mutations: -1, error: String(e) }
    }
  })()
`

/** 采样参数：超时上限 / 采样间隔 / 连续几次「没变」算安静 */
const SETTLE_DEFAULTS = { timeoutMs: 8_000, sampleMs: 250, quietSamples: 2 }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 纯函数（可单测）：拿「上一次状态 + 这次探针」推进一步安静判定。
 *
 * 判据：`readyState === 'complete'` **且**这次签名与上次相同；连续 `quietSamples`
 * 次才算安静。元素数一变（SPA 还在填内容）就**重新计数**。
 */
function stepQuiet(state, probe, quietSamples = SETTLE_DEFAULTS.quietSamples) {
  const sig = `${probe?.readyState ?? ''}|${probe?.interactions ?? -1}`
  const complete = probe?.readyState === 'complete'
  const same = state?.sig === sig
  const quiet = complete && same ? Number(state?.quiet ?? 0) + 1 : 0
  return { sig, quiet, settled: quiet >= quietSamples }
}

/**
 * 等页面安静。到上限（或探针一直失败）还没安静就返回 `settled: false` —— 调用方
 * 得把这件事**如实**告诉模型，不能当成「读到了最终状态」。
 *
 * @param {number} webContentsId 目标 webview 的 webContents id
 * @param {{ timeoutMs?: number, sampleMs?: number, quietSamples?: number, evaluate?: Function }} [options]
 *   `evaluate` 只给测试替换（默认走 CDP）—— 照 `browse-read.cjs` 的同一套路，
 *   这样真 Chrome / 假页面都能直接验这段逻辑，不必开 Electron。
 * @returns {Promise<{ settled: boolean, waitedMs: number, readyState: string, interactions: number, samples: number, failures: number }>}
 */
async function settle(webContentsId, options = {}) {
  const { timeoutMs, sampleMs, quietSamples } = { ...SETTLE_DEFAULTS, ...options }
  /* 延迟 require：只有没注入 evaluate 时才碰 cdp（顶层不 require electron） */
  const evaluate = options.evaluate ?? require('./cdp.cjs').evaluate
  const started = Date.now()
  let state = { sig: null, quiet: 0 }
  let last = null
  let samples = 0
  let failures = 0

  for (;;) {
    if (Date.now() - started >= timeoutMs) break
    let probe
    try {
      probe = await evaluate(webContentsId, PROBE_SCRIPT)
      samples += 1
    } catch {
      /* 页面正在导航 / guest 还没就绪这类偶发失败 —— 等一下再试，时间算进超时 */
      failures += 1
      if (Date.now() - started >= timeoutMs) break
      await sleep(sampleMs)
      continue
    }
    last = probe
    state = stepQuiet(state, probe, quietSamples)
    if (state.settled) break
    await sleep(sampleMs)
  }

  return {
    settled: state.settled === true,
    waitedMs: Date.now() - started,
    readyState: String(last?.readyState ?? ''),
    interactions: Number(last?.interactions ?? -1),
    samples,
    failures,
  }
}

module.exports = { PROBE_SCRIPT, SETTLE_DEFAULTS, stepQuiet, settle }
