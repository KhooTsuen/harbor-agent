/**
 * 真事件派发（合成 → 可信）
 *
 * 学 dsh-browser 的 `input.ts`（2026-09-24）：点击/打字不再用页面里的
 * `target.click()` / `dispatchEvent(new KeyboardEvent(...))` —— 那些是**合成事件**
 * （`isTrusted: false`），查可信度的站点会直接忽略，而且不会触发浏览器默认行为。
 * 这里走 Electron 的原生注入：
 *
 *   · 点击 → `webContents.sendInputEvent`（mouseDown / mouseUp）→ isTrusted: true
 *   · 文字 → `webContents.insertText`（真实 beforeinput / input 事件）
 *   · 回车 → `webContents.sendInputEvent`（keyDown / keyUp）
 *
 * ★ 为什么放主进程：渲染层在 sandbox 里，`isTrusted` 由浏览器内核赋予，
 *   页面脚本给不了 —— 「点真一点」这件事只有主进程做得到。
 *
 * 坐标来自渲染层已校验过的落点（`scripts.ts` 的 clickPointScript），
 * 是**这个 webContents 视口内**的坐标，正好是 sendInputEvent 要的那个坐标系。
 */

/** 拿一个还活着的 webContents；拿不到就返回 null（调用方报「网页已关」） */
function liveWebContents(id) {
  const { webContents } = require('electron')
  const wc = typeof id === 'number' ? webContents.fromId(id) : null
  return wc && !wc.isDestroyed() ? wc : null
}

/**
 * 在 (x, y) 派发一次真鼠标点击。
 * @param {number} webContentsId
 * @param {number} x
 * @param {number} y
 * @returns {{ ok: boolean, error?: string }}
 */
function clickAt(webContentsId, x, y) {
  const wc = liveWebContents(webContentsId)
  if (!wc) return { ok: false, error: '那个网页已经关了，点不了' }
  try {
    wc.focus()
    const px = Math.round(Number(x) || 0)
    const py = Math.round(Number(y) || 0)
    /* 先 mouseMove：一些框架靠 hover 状态才认「这是同一个元素上的点击」 */
    wc.sendInputEvent({ type: 'mouseMove', x: px, y: py })
    wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: '派发真点击失败：' + (e?.message ?? String(e)) }
  }
}

/**
 * 往**已聚焦**的元素插入真文字；可选回车。
 * 调用前渲染层已经 focus 过目标（focusScript），所以这里直接 insertText。
 *
 * @param {number} webContentsId
 * @param {string} text
 * @param {boolean} [pressEnter]
 * @returns {{ ok: boolean, error?: string }}
 */
function typeText(webContentsId, text, pressEnter) {
  const wc = liveWebContents(webContentsId)
  if (!wc) return { ok: false, error: '那个网页已经关了，打不了字' }
  try {
    wc.focus()
    wc.insertText(String(text ?? ''))
    if (pressEnter) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: '派发真输入失败：' + (e?.message ?? String(e)) }
  }
}

module.exports = { clickAt, typeText, liveWebContents }
