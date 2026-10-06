/**
 * 「这一次工具调用专用的 ctx」（从 `tool-runner.cjs` 搬出来）
 *
 * ── 为什么单独一个文件 ──
 * `tool-runner.cjs` 贴着 300 行硬红线（AGENT.md 硬约束 2），而子代理 v1 还要往里
 * 加一个注入。把它搬出来是**为了不超线**，不是顺手重构 —— 顺手重构是禁区，
 * 这里每一行都是必须动的。
 *
 * ── 两个注入的共同点 ──
 * 工具自己**不该知道自己的 call id**（那是 runner 的事），但发出去的事件又必须
 * 带上它 —— 界面按 `toolCallId` 把事件归位到「哪一次调用」。所以两处都在这儿注入：
 *
 *   · `progress`     —— 工具自己报进度（真机反馈 9a），事件 `agent.tool.progress`
 *   · `subagentEmit` —— 子代理把内部每一步转出来，事件 `subagent.step`（子代理 v1）
 *
 * ⚠️ 子代理的步骤**不能**发成 `agent.tool.started` 之类：那是父任务自己的工具流，
 *   混进去界面就会把子代理读过的文件算到父头上 —— 而父的上下文里根本没有它们
 *   （上下文隔离正是子代理存在的理由）。
 */

/**
 * @param {object} ctx 父这一轮的 ctx（`loop.cjs` 建的）
 * @param {{ emit: Function, toolCallId: string, toolName: string }} io
 * @returns {object} 这次调用专用的 ctx
 */
function buildRunCtx(ctx, { emit, toolCallId, toolName }) {
  return {
    ...ctx,
    /* 工具只管 `ctx.progress?.({ percent, note })` —— 不拼事件名、不用知道 call id */
    progress: (payload = {}) => {
      emit({
        type: 'agent.tool.progress',
        toolCallId,
        name: toolName,
        /* 报不出百分比就发 null —— 「还在动」和「0%」是两件事，别混 */
        percent:
          typeof payload.percent === 'number' && Number.isFinite(payload.percent)
            ? Math.max(0, Math.min(100, payload.percent))
            : null,
        note: payload.note ? String(payload.note) : '',
        done: payload.done === true,
      })
    },
    /*
     * 子代理（v1）：把子代理内部的每一步实时转给界面。
     *
     * 载荷形状由 `subagent.cjs` 给（kind / step / turns…），这里只**贴外壳** ——
     * 补上事件名与 `toolCallId`。子代理自己不知道父侧那次调用的 id，
     * 所以这一层是唯一的关联点（形状只有这一处定义，别在渲染层再翻译一遍）。
     */
    subagentEmit: (payload = {}) => {
      emit({ type: 'subagent.step', toolCallId, ...payload })
    },
  }
}

module.exports = { buildRunCtx }
