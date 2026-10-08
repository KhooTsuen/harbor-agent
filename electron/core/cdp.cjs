/**
 * CDP 直连内核（主进程侧）
 *
 * 背景：`<webview>` 是**渲染层**的 DOM 元素，但它的 **webContents 是主进程的** ——
 * 主进程拿到 `webContentsId` 就能用 `webContents.debugger` 走 Chrome DevTools
 * Protocol 直接驱动页面（取无障碍树、跑脚本、派输入…），不必每次都往返渲染层。
 *
 * 以前这些 CDP 调用是**散落**的：
 *   · `core/tools/browse-ax.cjs` 自己 attach + `Accessibility.getFullAXTree`
 *   · `selftest-report.cjs` 自己 `Page.captureScreenshot`
 *   · 真机脚本另有 `tools/shot/cdp.mjs`（那是连外部 Chrome 的，与这里无关）
 * 这里把「主进程驱动 webview 的 webContents」这一路收成一处 —— 后面 browse 的
 * 读取路径也要用它，别再多写一份 attach/ sendCommand。
 *
 * ⚠️ 只在**主进程**里可用（要 electron）。纯 Node 自检 import 本模块**不会**炸：
 *    `electron` 是**延迟** require 的（在函数体里），顶层只导出纯函数。
 *
 * ⚠️ 一个 webContents 只 attach 一次（已附加就复用）—— CDP 版本写死 1.3，
 *    和 `browse-ax.cjs` 原来用的一致。
 */

const CDP_VERSION = '1.3'

/** 拿一个还活着的 webContents；拿不到就抛「网页已关」（调用方据此回话） */
function resolve(webContentsId) {
  const { webContents } = require('electron')
  const wc = webContents.fromId(Number(webContentsId))
  if (!wc || wc.isDestroyed()) throw new Error('那个网页已经关了')
  return wc
}

/** 附加调试器（已附加就复用）。同一 wc 重复调用是安全的 */
function attach(webContentsId) {
  const wc = resolve(webContentsId)
  if (!wc.debugger.isAttached()) wc.debugger.attach(CDP_VERSION)
  return wc
}

/** 发一条 CDP 命令 */
async function send(webContentsId, method, params) {
  const wc = attach(webContentsId)
  return wc.debugger.sendCommand(method, params)
}

/**
 * 从 `Runtime.evaluate` 的原始返回里取值 / 抛错。
 *
 * ★ 单独拎出来是**为了能被纯 Node 自检**（`send` 要 electron，这个不要）。
 * 页面自己抛错时，只取**第一行**原因 —— 别把 `at <anonymous>:1:1` 那串堆栈
 * 灌进模型上下文（和 `tools/shot/cdp.mjs` 的 evaluate 一个口径）。
 *
 * @param {{ exceptionDetails?: any, result?: { value?: any } }} res `Runtime.evaluate` 的返回
 */
function valueOfEvaluate(res) {
  const details = res?.exceptionDetails
  if (details) {
    const text = details.exception?.description || details.text || '页面里执行脚本出错'
    throw new Error(String(text).split('\n')[0])
  }
  return res?.result?.value
}

/**
 * 在页面里跑一段表达式并取值（`Runtime.evaluate` + `returnByValue`）。
 *
 * @param {number} webContentsId
 * @param {string} expression 要在页面里求值的表达式（**要有返回值**，否则拿到 undefined）
 * @param {{ awaitPromise?: boolean }} [options]
 */
async function evaluate(webContentsId, expression, { awaitPromise = false } = {}) {
  const res = await send(webContentsId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  })
  return valueOfEvaluate(res)
}

/** 读整棵无障碍树（`Accessibility.getFullAXTree`）—— 返回原始 nodes 数组 */
async function getFullAxTree(webContentsId) {
  const res = await send(webContentsId, 'Accessibility.getFullAXTree')
  return res?.nodes ?? []
}

module.exports = { CDP_VERSION, resolve, attach, send, evaluate, valueOfEvaluate, getFullAxTree }
