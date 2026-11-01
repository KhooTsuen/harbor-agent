/**
 * `page:context` 的落槽逻辑（2026-10-21，从 `ext-ops.cjs` 拆出 —— 那边超 300 行了）
 *
 * ── 两条来源 ─────────────────────────────────────────────────
 *
 * ① **正文**（`text`）：读当前页 / 切页面自动上报。原样进槽。
 * ② **结构化观察**（`observation`）：面板上那个「观察页面」按钮。
 *    渲染成 markdown **仍然只有 `renderObservation` 一处实现**（硬约束 #9）——
 *    所以这里调它，不在扩展侧另画一份。
 *
 * 两种都**只写槽、不写会话文件** —— 这就是「不占对话流」这条要求的落点。
 */

const pageCtx = require('./page-context-slot.cjs')
const { renderObservation } = require('./ext-observe.cjs')

/**
 * @param {object} payload host 转发上来的原始载荷
 * @param {{ selected: () => string }} deps `selected()` = 侧边栏选中的那条会话
 */
function ingestPageContext(payload, deps) {
  const opts = { selected: deps?.selected ?? (() => '') }
  const obs = payload?.observation && typeof payload.observation === 'object' ? payload.observation : null
  if (!obs) return pageCtx.ingest(payload, opts)

  const rendered = renderObservation(obs)
  return pageCtx.ingest(
    {
      url: String(obs.url ?? ''),
      title: String(obs.title ?? ''),
      text: rendered.markdown,
      truncated: rendered.truncated === true,
      source: payload?.source,
      sessionId: payload?.sessionId,
    },
    opts,
  )
}

module.exports = { ingestPageContext }
