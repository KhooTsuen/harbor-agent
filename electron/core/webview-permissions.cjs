/**
 * 网页标签的权限闸
 *
 * ⚠️ 这个文件是**审计问题 21** 的修复。在那之前全仓**一个 handler 都没装**
 * （`setPermissionRequestHandler` 搜不到）：网页上任何一段 JS 调
 * `getUserMedia()`（摄像头/麦克风）、`getDisplayMedia()`（录屏）、
 * `Notification`、`navigator.geolocation`、`navigator.clipboard.readText()` 时，
 * 走的是 Chromium 的默认行为（**一部分直接给**，用户一次都不会被问）。
 *
 * 而右栏那个网页标签是「Agent 去逛的网页」，是应用里最脏的注入来源
 * （见 `core/tools/browse.cjs` 的文件头：网页上的文字会被模型当数据读进来）。
 * 网页脚本不该在用户不知情时拿到摄像头、录屏、剪贴板。
 *
 * 所以：**默认全拒**，只有 `HARMLESS` 里那几个放行 ——
 * 它们拿不到任何用户数据，拦住只会让正常网页坏掉（最容易被当成 bug 报上来的是
 * 「视频全屏按钮点不动」）。
 *
 * ── 为什么装在 `persist:agent-browser` 这个分区上而不是全局 ──
 *
 * 网页标签用独立分区（见 `src/components/layout/BrowserTab.tsx` 的
 * `partition="persist:agent-browser"`），应用自己的界面不在里面，
 * 所以这里拒不会波及界面（界面的通知是主进程发的，根本不走这个 handler）。
 *
 * `decide` 是纯函数、`install` 只要求一个「长得像 session 的对象」，
 * 所以自检/单测能用一个假的 session 把它跑一遍（不用起 Electron）。
 */

/** 拿不到用户数据、拦住只会让正常网页坏掉的那几个 */
const HARMLESS = new Set(['fullscreen', 'clipboard-sanitized-write'])

/** 网页标签用的分区名（和 BrowserTab.tsx 里那个字符串必须一致） */
const PARTITION = 'persist:agent-browser'

/** 这个权限给不给。给的理由只有一条：它拿不到用户数据 */
function decide(permission) {
  return HARMLESS.has(String(permission ?? ''))
}

/**
 * 装到分区 session 上。
 *
 * @param {{ setPermissionRequestHandler?: Function, setPermissionCheckHandler?: Function }} ses
 * @param {{ info?: Function }} [log]
 * @returns {boolean} 装上了没有；false = 拿到的不是个 session
 */
function install(ses, log) {
  if (!ses || typeof ses.setPermissionRequestHandler !== 'function') return false

  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const allow = decide(permission)
    const where = details?.requestingUrl ? `（${String(details.requestingUrl).slice(0, 120)}）` : ''
    log?.info?.(
      allow
        ? `网页要权限：${permission} —— 放行（无害那一类）${where}`
        : `网页要权限：${permission} —— 已拒绝（默认全拒，见 core/webview-permissions.cjs）${where}`,
    )
    callback(allow)
  })

  /*
   * check 是另一半（同步版）：`navigator.permissions.query()` 和一部分 API 走它。
   * 只装 request 会留下一条缝 ——「查得到、要得到」，看着像给了、其实没拦住。
   * 两边用同一个 `decide`，口径不会漂。
   */
  if (typeof ses.setPermissionCheckHandler === 'function') {
    ses.setPermissionCheckHandler((_contents, permission) => decide(permission))
  }

  return true
}

module.exports = { PARTITION, HARMLESS, decide, install }
